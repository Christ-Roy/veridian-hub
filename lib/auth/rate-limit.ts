/**
 * Rate limiter IP / clé — fenêtre à compteur partagé en base (VER-270).
 *
 * Cible : routes publiques (Auth.js, signup, MCP…) et plafonds par compte. Le compte est tenu dans la table
 * `hub_app.compteurs_fenetre` (lib/auth/compteurs.ts) : deux instances du Hub voient le même plafond, sans mémoire de processus.
 *
 * Une instance de RateLimiter = une fenêtre + cap + nom (le nom est la clé de la table, et ne doit pas être partagé).
 * Toutes les méthodes sont asynchrones. Panne de base : refus (fermé), journalisé `[ratelimit-indisponible]`.
 */

import { timingSafeEqual } from 'node:crypto';

import { cleIp } from '@/lib/auth/ip-client';
import { compterFenetre, lireFenetre, viderLimiteur } from '@/lib/auth/compteurs';

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; remaining: 0; resetAt: number; retryAfterSeconds: number };

/** Délai rendu quand la base ne répond pas : le client réessaie, sans qu'on le laisse passer. */
const RETRY_PANNE_S = 30;

export class RateLimiter {
  constructor(
    private readonly options: {
      /** Capacité max sur la fenêtre */
      capacity: number;
      /** Durée de la fenêtre en ms */
      windowMs: number;
      /** Nom unique du limiteur (clé de la table, journaux) */
      name: string;
    }
  ) {
    if (options.capacity <= 0) throw new Error('capacity must be > 0');
    if (options.windowMs <= 0) throw new Error('windowMs must be > 0');
  }

  private get limiteur(): string {
    return `${this.options.name}@${this.options.windowMs}`;
  }

  private panne(err: unknown, now: number): RateLimitResult {
    console.error(
      JSON.stringify({ tag: '[ratelimit-indisponible]', level: 'error', limiter: this.options.name, erreur: err instanceof Error ? err.message : String(err), ts: new Date(now).toISOString() })
    );
    return { ok: false, remaining: 0, resetAt: now + RETRY_PANNE_S * 1000, retryAfterSeconds: RETRY_PANNE_S };
  }

  /**
   * Enregistre un hit pour `key` et retourne si la requête est autorisée.
   * Si non, retourne aussi `retryAfterSeconds` pour le header Retry-After.
   *
   * Important : on incrémente AVANT de tester, donc même les requêtes refusées comptent dans la fenêtre
   * (sinon on pourrait bypasser en spammant — chaque tentative coûte).
   */
  async enforce(key: string, now: number = Date.now()): Promise<RateLimitResult> {
    let compte: number;
    let resetAt: number;
    try {
      ({ compte, resetAt } = await compterFenetre(this.limiteur, key, this.options.windowMs, now));
    } catch (err) {
      return this.panne(err, now);
    }
    if (compte > this.options.capacity) {
      return { ok: false, remaining: 0, resetAt, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    }
    return { ok: true, remaining: this.options.capacity - compte, resetAt };
  }

  /**
   * Lire sans compter : la fenêtre de `key` est-elle déjà pleine ? Pour un limiteur qui ne compte que les ÉCHECS (gardien d'administration,
   * 27/11) : on bloque tout dès le plafond atteint, mais un appel réussi ne consomme rien.
   */
  async depasse(key: string, now: number = Date.now()): Promise<RateLimitResult> {
    let compte: number;
    let resetAt: number;
    try {
      ({ compte, resetAt } = await lireFenetre(this.limiteur, key, this.options.windowMs, now));
    } catch (err) {
      return this.panne(err, now);
    }
    if (compte >= this.options.capacity) return { ok: false, remaining: 0, resetAt, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    return { ok: true, remaining: this.options.capacity - compte, resetAt };
  }

  /**
   * Variante avec bypass E2E intégré.
   *
   * Si les headers portent le header `x-veridian-e2e-bypass-ratelimit` valide ET qu'on est hors prod (DEPLOY_ENV !== 'prod'),
   * on retourne `{ok:true, bypassed:true}` SANS incrémenter le compteur — la requête passe gratuitement.
   *
   * Sinon délègue à `enforce(key)` (comportement normal).
   *
   * Audit log : émet un unique warn `[ratelimit-bypass]` côté process pour chaque bypass utilisé.
   *
   * Utilisation typique côté route :
   * ```ts
   * const rate = await signupLimiter.enforceWithBypass(ip, request.headers);
   * if (!rate.ok) return tooManyResponse(rate.retryAfterSeconds);
   * ```
   */
  async enforceWithBypass(key: string, headers: Headers, now: number = Date.now()): Promise<RateLimitResult & { bypassed?: boolean }> {
    if (shouldBypassRateLimit(headers)) {
      // Audit observabilité — un seul warn par requête bypassée.
      console.warn(
        JSON.stringify({
          tag: '[ratelimit-bypass]',
          level: 'warn',
          limiter: this.options.name,
          key,
          deploy_env: process.env.DEPLOY_ENV ?? 'unset',
          ts: new Date(now).toISOString(),
        }),
      );
      return {
        ok: true,
        remaining: this.options.capacity,
        resetAt: now + this.options.windowMs,
        bypassed: true,
      };
    }
    return this.enforce(key, now);
  }

  /** Utilitaire tests : remet à zéro les fenêtres de ce limiteur. */
  reset(): Promise<void> {
    return viderLimiteur(this.limiteur);
  }
}

/** Clé d'un limiteur par appelant : son IPv4, ou le /64 de son IPv6. Non choisie par lui (lib/auth/ip-client.ts). */
export const extractClientIp = cleIp;

/**
 * Bypass rate-limit pour les tests E2E staging — STRICTEMENT staging.
 *
 * Contexte : derrière Traefik staging, `x-forwarded-for` est réécrit par le proxy, donc toutes les requêtes E2E partagent le même
 * bucket IP côté Hub. La suite `e2e/staging-full` enchaîne 60+ appels admin sur quelques minutes.
 *
 * Solution : un header `x-veridian-e2e-bypass-ratelimit` portant un secret long (>= 32 chars), comparé timing-safe à
 * `E2E_RATELIMIT_BYPASS_SECRET`, et accepté UNIQUEMENT quand `DEPLOY_ENV !== 'prod'`.
 *
 * Triple garde-fou anti-fuite prod :
 *   1. Gate ENV stricte : `DEPLOY_ENV !== 'prod'` (DEPLOY_ENV, jamais NODE_ENV).
 *   2. Secret obligatoire ET ≥ 32 chars.
 *   3. Comparaison timing-safe (`crypto.timingSafeEqual`).
 */
export function shouldBypassRateLimit(headers: Headers): boolean {
  // Garde-fou 1 : DEPLOY_ENV. Variable fiable, pas NODE_ENV (qui vaut 'production' même sur le build staging Next.js).
  if (process.env.DEPLOY_ENV === 'prod') return false;

  const secret = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  // Garde-fou 2 : secret configuré ET assez long.
  if (!secret || secret.length < 32) return false;

  const provided = headers.get('x-veridian-e2e-bypass-ratelimit');
  if (!provided) return false;

  // Garde-fou 3 : comparaison timing-safe. timingSafeEqual exige des Buffers de même longueur — sinon throw.
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    // Normalise quand même le timing en faisant un compare dummy.
    try {
      timingSafeEqual(b, Buffer.alloc(b.length));
    } catch {
      /* noop */
    }
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Instances partagées pour les routes Auth.js ────────────────────────────
//
// Caps choisis pour ne pas pénaliser les users légitimes :
// - 10 starts/min/IP suffit largement pour un user qui clique "Login with Google" (sauf bot qui spamme le bouton).
// - 30 callbacks/min/IP pour ne pas bloquer les redirects OAuth normaux.

export const oauthStartLimiter = new RateLimiter({
  capacity: 10,
  windowMs: 60_000,
  name: 'oauth-start',
});

export const oauthCallbackLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'oauth-callback',
});

// Limit anti-brute-force pour les routes admin protégées par x-admin-secret.
// Cap volontairement bas : un usage légitime fait quelques appels/min (provisioning d'un client), pas des centaines.
export const adminApiLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'admin-api',
});

// Anti-DoS sur l'endpoint signup public. 5/min/IP est généreux pour un humain légitime, bloque les bots.
export const signupLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'signup',
});

// Anti-brute-force password sur /api/auth/callback/credentials.
// La clé est le couple IP + email ; le second plafond, par IP seule et bien plus large, borne le balayage d'adresses.
export const credentialsLoginLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'credentials-login',
});

export const credentialsLoginIpLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'credentials-login-ip',
});

// Anti-flood sur POST /api/invitations/create (machine-to-machine HMAC). Clé = IP, pas l'app HMAC.
export const invitationCreateLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'invitation-create',
});

// Anti brute-force token sur GET /api/invitations/[token]/verify.
export const invitationVerifyLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'invitation-verify',
});

// Onboarding première connexion : vérification d'un token public durable.
export const onboardingVerifyLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'onboarding-verify',
});

// Activation du compte : coûte un bcrypt + peut déclencher du provisioning.
export const onboardingConsumeLimiter = new RateLimiter({
  capacity: 10,
  windowMs: 60_000,
  name: 'onboarding-consume',
});

// Renouveler un lien d'activation expiré : chaque appel abouti envoie un mail à l'adresse du compte.
export const renouvellementIpLimiter = new RateLimiter({ capacity: 5, windowMs: 15 * 60_000, name: 'onboarding-renouveler-ip' });
export const renouvellementLienLimiter = new RateLimiter({ capacity: 2, windowMs: 60 * 60_000, name: 'onboarding-renouveler-lien' });

// Qualification post-activation, sessionnée. Cap généreux pour la sauvegarde progressive.
export const onboardingQualificationLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'onboarding-qualification',
});

// Poll endpoint GET /api/tenants/[tenantId]/billing-state — réconciliation CONTRAT-BILLING §6.3. Clé = app HMAC.
export const billingStatePollLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'billing-state-poll',
});

// Rate-limit sur POST /api/account/sessions/revoke-all : chaque appel pousse vers toutes les apps.
export const sessionsRevokeAllLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'sessions-revoke-all',
});

// Rate-limit sur GET /api/users/by-email (Discovery cross-app). Avant HMAC : par IP ; après HMAC : par app.
// On utilise deux limiters distincts pour éviter le bypass par variation de `x-veridian-app`.
export const discoveryPreVerifyLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'discovery-pre-verify',
});

export const discoveryAppLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
  name: 'discovery-app',
});

// Rate-limit Mail Gateway v1 (`POST /api/mail/send-as-user`). Avant HMAC : par IP ; après : par app + user.
export const mailSendAsUserPreVerifyLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'mail-send-pre-verify',
});

export const mailSendAsUserLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'mail-send-as-user',
});

/** MCP : enregistrement de clients IA (RFC 7591), public. */
export const mcpRegisterLimiter = new RateLimiter({ capacity: 10, windowMs: 60 * 60_000, name: 'mcp-register' });
/** MCP : échange et renouvellement de jetons, par IP. */
export const mcpTokenLimiter = new RateLimiter({ capacity: 60, windowMs: 60_000, name: 'mcp-token' });
/** MCP : appels de la porte, par utilisateur. */
export const mcpCallLimiter = new RateLimiter({ capacity: 120, windowMs: 60_000, name: 'mcp-call' });
