/**
 * Refill leads — orchestrateur côté Hub.
 *
 * Spec : docs/PRICING-VERIDIAN.md §95-108 (grille refill dégressive) + §78
 * (welcome leads), docs/CONTRAT-BILLING.md §8.4 (refill = flux séparé de
 * `update-plan`, Hub seul maître Stripe).
 *
 * Ce module héberge la logique pure du refill :
 *   - calcul du prix (via `@veridian/shared/pricing/refill`)
 *   - mapping plan Hub canonique → plan local Prospection (`free` → `freemium`,
 *     `enterprise` → `business`)
 *   - quantités welcome par plan (depuis `@veridian/shared/pricing/plans`)
 *   - dérivation d'idempotency_key DÉTERMINISTES :
 *       - pour un purchase  : dérivé de `event.id` Stripe → retry safe
 *       - pour un welcome   : dérivé de `tenantId + welcome_plan` → un seul
 *                             grant par (tenant, palier) même si le Hub rejoue
 *   - client HTTP HMAC vers `POST <prospection>/api/tenants/{id}/credit-leads`
 *
 * La route Checkout (`app/api/billing/refill-leads/checkout/route.ts`) et le
 * dispatcher webhook (`lib/stripe/dispatcher.ts`) consomment cette lib — pas
 * de logique métier dupliquée ailleurs.
 *
 * Side-effects → réseau (HMAC HTTP) + Stripe ; pour les tests on injecte
 * `fetchImpl` / `clientFactory`.
 */

import { createHash, createHmac } from 'crypto';

import {
  PLANS as CANONICAL_PLANS,
  calculateRefillCostCents,
  MAX_LEADS_PER_REFILL_ORDER,
  type RefillTierKey,
  type PlanKey as CanonicalPlanKey,
} from '@veridian/shared';

import { readProspectionSecret } from '@/lib/prospection/client';

/** Version du contrat billing supportée (aligné CONTRAT-BILLING v2). */
export const REFILL_CONTRACT_VERSION = '2.0';

/** Timeout HTTP réseau pour l'appel `credit-leads`. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Nombre de retries pour le dispatch post-paiement (3 tentatives, total ~14s). */
export const REFILL_DISPATCH_MAX_RETRIES = 2;
/** Délais d'attente entre retries (1s, 3s) — backoff exponentiel doux. */
const RETRY_BACKOFF_MS = [1000, 3000];

// ─────────────────────────────────────────────────────────────────────────────
// Mapping plans : Hub canonique → Prospection local
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plan local Prospection accepté par l'endpoint `credit-leads` côté Prospection
 * (cf src/lib/billing/plans.ts dans veridian-prospection).
 */
export type ProspectionLocalPlan = 'freemium' | 'pro' | 'business';

/**
 * Mappe un tier canonique (`free | pro | business | enterprise`) vers le tier
 * Prospection local. `enterprise` → `business` (pas de palier enterprise local
 * pour le refill — cf ticket §3 mapping).
 */
export function mapHubTierToProspectionPlan(
  tier: 'free' | 'pro' | 'business' | 'enterprise',
): ProspectionLocalPlan {
  switch (tier) {
    case 'free':
      return 'freemium';
    case 'pro':
      return 'pro';
    case 'business':
    case 'enterprise':
      return 'business';
  }
}

/**
 * Mappe un plan local Prospection vers le tier de grille refill
 * (`freemium | pro | business`) consommé par `calculateRefillCostCents`.
 *
 * Identique à `mapHubTierToProspectionPlan` à la nuance que l'input est déjà
 * "local" (vient de la BDD `Tenant.prospectionPlan` qui stocke des noms
 * locaux `freemium | pro | business`).
 */
export function mapProspectionPlanToRefillTier(
  plan: ProspectionLocalPlan,
): RefillTierKey {
  // Les enums coïncident, mais on garde une fonction explicite pour pouvoir
  // évoluer indépendamment si la grille refill diverge un jour.
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome leads — lookup quantité depuis le catalogue shared
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renvoie la quantité de welcome leads associée à un plan Prospection LOCAL.
 *
 * Source : `shared/shared/pricing/plans.ts` champ `welcome_leads`. La clé
 * canonique côté shared est `prospection-<local>` (ex `prospection-pro`).
 */
export function getWelcomeLeadsForProspectionPlan(
  plan: ProspectionLocalPlan,
): number {
  const canonicalKey = `prospection-${plan === 'freemium' ? 'free' : plan}` as CanonicalPlanKey;
  const planDef = CANONICAL_PLANS[canonicalKey];
  if (!planDef) {
    throw new Error(
      `[refill] catalogue shared n'expose pas le plan ${canonicalKey} ` +
        `(prospection local "${plan}") — corriger le mapping`,
    );
  }
  return planDef.welcome_leads ?? 0;
}

/**
 * Calcule le DELTA de welcome leads à créditer lors d'un upgrade de plan
 * Prospection. Retourne 0 si downgrade ou même palier (pas de débit, leads
 * permanents — `PRICING-VERIDIAN.md` §97).
 */
export function computeWelcomeLeadsDelta(
  oldPlan: ProspectionLocalPlan | null,
  newPlan: ProspectionLocalPlan,
): number {
  const newQty = getWelcomeLeadsForProspectionPlan(newPlan);
  if (!oldPlan) return newQty;
  const oldQty = getWelcomeLeadsForProspectionPlan(oldPlan);
  const delta = newQty - oldQty;
  return delta > 0 ? delta : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency keys — UUID v4-shaped DÉTERMINISTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit un identifiant UUID-formaté à partir d'un seed arbitraire.
 *
 * On utilise SHA-256 (16 bytes) puis on force la version (4) et le variant
 * (RFC 4122) pour produire une string UUID *valide au sens regex* —
 * l'endpoint Prospection valide `idempotency_key: z.string().uuid()`.
 *
 * Ce n'est pas un vrai UUID v5 RFC (qui exige un namespace UUID + SHA-1).
 * Ça reste un UUID v4 *déterministe* — c'est exactement ce qu'on veut :
 *   - même seed → même UUID (retry safe)
 *   - format UUID valide → passe la validation Prospection
 *   - pas de dépendance externe (`uuid` pas dans package.json)
 *
 * Format : `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` (version 4, variant RFC).
 */
export function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const bytes = hash.split('').map((c, i) => {
    // Position 12 (1er char de v4 nibble) : force '4'
    if (i === 12) return '4';
    // Position 16 (1er char du variant) : force entre 8 et b (variant RFC)
    if (i === 16) {
      const n = parseInt(c, 16);
      return ((n & 0x3) | 0x8).toString(16);
    }
    return c;
  });
  const hex = bytes.join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Idempotency_key pour un crédit *purchase* — dérivé du Stripe event id, donc
 * un retry Stripe sur le même event régénère la même clé → l'endpoint
 * Prospection renvoie un `200 idempotent_replay` sans double-crédit.
 */
export function purchaseIdempotencyKey(stripeEventId: string): string {
  return deterministicUuid(`refill:purchase:${stripeEventId}`);
}

/**
 * Idempotency_key pour un crédit *welcome* — dérivé du tenant + palier.
 *
 * Garantie : pour un (tenantId, welcome_plan) donné, la clé est stable même
 * entre process restarts → un provisioning rejoué, un upgrade rejoué, un retry
 * background réémettent toujours la même clé. Ajouté au garde DB Prospection
 * `(workspace_id, welcome_plan) UNIQUE`, ça interdit le double-grant même en
 * face d'un bug agent.
 */
export function welcomeIdempotencyKey(
  tenantId: string,
  welcomePlan: ProspectionLocalPlan,
): string {
  return deterministicUuid(`refill:welcome:${tenantId}:${welcomePlan}`);
}

/**
 * Idempotency_key pour le seed metadata d'une session Checkout — dérivé du
 * tenantId + quantity + timestamp arrondi à la seconde. Permet de re-tenter
 * la création de session côté Hub sans créer 2 sessions Stripe distinctes
 * pour le même clic user (s'il refresh la page p.ex.).
 */
export function checkoutSeedIdempotencyKey(
  tenantId: string,
  quantity: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return deterministicUuid(
    `refill:checkout:${tenantId}:${quantity}:${nowSeconds}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calcul de prix — pure wrapper avec cap de sécurité
// ─────────────────────────────────────────────────────────────────────────────

export class RefillQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefillQuantityError';
  }
}

/**
 * Calcule le coût total en centimes pour une commande refill. Wrap autour de
 * `calculateRefillCostCents` shared, avec validation explicite des bornes
 * (refus < 1, refus > MAX_LEADS_PER_REFILL_ORDER) qui throw un type erreur
 * distinct utilisable côté route HTTP (→ 400 Bad Request).
 */
export function priceRefillCents(
  plan: ProspectionLocalPlan,
  quantity: number,
): number {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RefillQuantityError('quantity must be a positive integer');
  }
  if (quantity > MAX_LEADS_PER_REFILL_ORDER) {
    throw new RefillQuantityError(
      `quantity ${quantity} exceeds MAX_LEADS_PER_REFILL_ORDER (${MAX_LEADS_PER_REFILL_ORDER})`,
    );
  }
  return calculateRefillCostCents(mapProspectionPlanToRefillTier(plan), quantity);
}

// ─────────────────────────────────────────────────────────────────────────────
// Client HTTP HMAC vers Prospection — POST credit-leads
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditLeadsPurchaseBody {
  quantity: number;
  source: 'purchase';
  stripe_payment_id: string;
  idempotency_key: string;
  contract_version: typeof REFILL_CONTRACT_VERSION;
}

export interface CreditLeadsWelcomeBody {
  quantity: number;
  source: 'welcome';
  welcome_plan: ProspectionLocalPlan;
  idempotency_key: string;
  contract_version: typeof REFILL_CONTRACT_VERSION;
}

export type CreditLeadsBody = CreditLeadsPurchaseBody | CreditLeadsWelcomeBody;

export interface CreditLeadsResponse {
  credited?: number;
  balance?: number;
  idempotent_replay?: boolean;
  error?: string;
  message?: string;
}

export interface CreditLeadsClientOptions {
  apiUrl: string;
  hubSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class CreditLeadsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'CreditLeadsError';
  }
}

/**
 * Client minimal pour appeler `POST <prospection>/api/tenants/{id}/credit-leads`
 * en HMAC Pattern A — même signature que `ProspectionClient` (lib/prospection/
 * client.ts) mais sur un path paramétré et avec une réponse typée.
 *
 * Pas de retry interne : la stratégie de retry est gérée par l'appelant
 * (dispatcher webhook) pour pouvoir piloter le backoff / l'alerte Telegram
 * selon le contexte.
 */
export class CreditLeadsClient {
  private readonly apiUrl: string;
  private readonly hubSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CreditLeadsClientOptions) {
    if (!opts.apiUrl) throw new Error('CreditLeadsClient: apiUrl required');
    if (!opts.hubSecret) throw new Error('CreditLeadsClient: hubSecret required');
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.hubSecret = opts.hubSecret;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * `tenantIdOrEmail` : `Tenant.id` UUID local Prospection OU email du owner
   * Hub. Côté Prospection, `resolveTenantByIdOrEmail` accepte les deux (cf
   * `src/lib/hub/tenant-lookup.ts` veridian-prospection).
   */
  async creditLeads(
    tenantIdOrEmail: string,
    body: CreditLeadsBody,
  ): Promise<CreditLeadsResponse> {
    const rawBody = JSON.stringify(body);
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', this.hubSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const url = `${this.apiUrl}/api/tenants/${encodeURIComponent(tenantIdOrEmail)}/credit-leads`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Veridian-Timestamp': timestamp,
          'X-Veridian-Hub-Signature': signature,
        },
        body: rawBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await response.text();
      const parsed = (text ? safeJsonParse(text) : {}) as CreditLeadsResponse;

      if (!response.ok) {
        throw new CreditLeadsError(
          parsed?.error || parsed?.message || `HTTP ${response.status}`,
          response.status,
          parsed,
        );
      }
      return parsed;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof CreditLeadsError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CreditLeadsError(
          `Prospection credit-leads timeout after ${this.timeoutMs}ms`,
          0,
          null,
        );
      }
      throw err;
    }
  }
}

/**
 * Factory : construit un CreditLeadsClient depuis l'ENV. Renvoie null si la
 * config est incomplète (laisse l'appelant décider de loguer ou throw).
 *
 * ENV consommées :
 *   - PROSPECTION_API_URL — URL publique (https://prospection.app.veridian.site)
 *   - PROSPECTION_HUB_API_SECRET ou PROSPECTION_TENANT_API_SECRET (legacy)
 */
export function createCreditLeadsClientFromEnv(): CreditLeadsClient | null {
  const apiUrl = process.env.PROSPECTION_API_URL;
  const hubSecret = readProspectionSecret();
  if (!apiUrl || !hubSecret) return null;
  return new CreditLeadsClient({ apiUrl, hubSecret });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers high-level — dispatchers avec retry exponentiel
// ─────────────────────────────────────────────────────────────────────────────

export type DispatchResult =
  | { ok: true; response: CreditLeadsResponse; attempts: number }
  | { ok: false; error: string; status?: number; attempts: number };

/**
 * Dispatch un crédit `purchase` après webhook Stripe avec retry exponentiel.
 *
 * Retry sur 5xx + erreurs réseau (timeout, fetch fail). PAS de retry sur 4xx
 * (le body est rejeté — re-tenter ne change rien, on log et on alerte).
 *
 * Idempotency_key DÉTERMINISTE dérivé du Stripe event.id → un retry réémet
 * la même clé, l'endpoint Prospection renvoie 200 sans double-crédit.
 */
export async function dispatchRefillPurchase(
  client: CreditLeadsClient,
  args: {
    tenantIdOrEmail: string;
    quantity: number;
    stripeEventId: string;
    stripePaymentId: string;
  },
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DispatchResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const body: CreditLeadsPurchaseBody = {
    quantity: args.quantity,
    source: 'purchase',
    stripe_payment_id: args.stripePaymentId,
    idempotency_key: purchaseIdempotencyKey(args.stripeEventId),
    contract_version: REFILL_CONTRACT_VERSION,
  };
  return executeWithRetry(client, args.tenantIdOrEmail, body, sleep);
}

/**
 * Dispatch un crédit `welcome` lors du provisioning ou de l'upgrade.
 *
 * Idempotency_key DÉTERMINISTE dérivé de `tenantId + welcome_plan` → un grant
 * rejoué (process restart, ré-provisioning) réémet la même clé, Prospection
 * renvoie 200 `idempotent_replay`. En double sécurité, l'index unique
 * Prospection `(workspace_id, welcome_plan)` rattrape les retries qui auraient
 * une autre clé.
 */
export async function dispatchRefillWelcome(
  client: CreditLeadsClient,
  args: {
    tenantIdOrEmail: string;
    quantity: number;
    welcomePlan: ProspectionLocalPlan;
    /** Optionnel : ID stable pour le key (default = tenantIdOrEmail). */
    keyTenantId?: string;
  },
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DispatchResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const body: CreditLeadsWelcomeBody = {
    quantity: args.quantity,
    source: 'welcome',
    welcome_plan: args.welcomePlan,
    idempotency_key: welcomeIdempotencyKey(
      args.keyTenantId ?? args.tenantIdOrEmail,
      args.welcomePlan,
    ),
    contract_version: REFILL_CONTRACT_VERSION,
  };
  return executeWithRetry(client, args.tenantIdOrEmail, body, sleep);
}

async function executeWithRetry(
  client: CreditLeadsClient,
  tenantIdOrEmail: string,
  body: CreditLeadsBody,
  sleep: (ms: number) => Promise<void>,
): Promise<DispatchResult> {
  let lastError: { error: string; status?: number } | null = null;

  for (let attempt = 0; attempt <= REFILL_DISPATCH_MAX_RETRIES; attempt++) {
    try {
      const response = await client.creditLeads(tenantIdOrEmail, body);
      return { ok: true, response, attempts: attempt + 1 };
    } catch (err) {
      if (err instanceof CreditLeadsError) {
        // 4xx : pas de retry — le payload est rejeté, c'est un bug code-côté.
        if (err.status >= 400 && err.status < 500) {
          return { ok: false, error: err.message, status: err.status, attempts: attempt + 1 };
        }
        lastError = { error: err.message, status: err.status };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = { error: msg };
      }

      if (attempt < REFILL_DISPATCH_MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
        await sleep(backoff);
      }
    }
  }

  return {
    ok: false,
    error: lastError?.error ?? 'unknown',
    status: lastError?.status,
    attempts: REFILL_DISPATCH_MAX_RETRIES + 1,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
