/**
 * Receveur factorisé pour les webhooks app → Hub (contrat v1.4 §7.1 +
 * CONTRAT-HUB-API-REF.md `Webhooks app → Hub`).
 *
 * Pattern figé v1.4 :
 *   - Auth : Bearer token statique par app (`<APP>_WEBHOOK_TOKEN`).
 *     Pas de HMAC ici — la confidentialité du token suffit pour un canal
 *     server-to-server interne (Traefik TLS edge + ENV scoping par app).
 *   - Dédup : PK composite `(app, idempotency_key)` dans `hub_app.webhook_dedup`.
 *     Fenêtre 24h. Replay du même idempotency_key dans la fenêtre = 200
 *     idempotent (pas de re-process), passé la fenêtre = re-process (cron
 *     purge les rows > 24h, P2+).
 *   - Dispatch : table d'event_type → handler injectée par la route appelante.
 *     Handler inconnu = log warn + 200 (on persiste quand même la row pour
 *     audit/forensics).
 *
 * Distinct du HMAC legacy de `/api/webhooks/notifuse` (header
 * `x-veridian-notifuse-signature`) qui reste actif pour les events
 * `email.sent` / `tenant.provisioned` / `tenant.quota_exceeded` envoyés
 * par le fork Notifuse en prod.
 *
 * Référence : `docs/CONTRAT-HUB-API-REF.md` section "Webhooks app → Hub".
 */

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import {
  RotatingSecret,
  logWebhookAuth,
  matchRotatingSecret,
} from '@/lib/webhooks/secret-rotation';

/** Format payload v1.4 attendu. */
export interface V14WebhookPayload {
  /** Event type — ex: `tenant.touched`, `tenant.member_role_changed`. */
  event: string;
  /** ID du tenant côté Hub (UUID) ou côté app (slug) selon l'event. */
  tenant_id: string;
  /** Champs spécifiques à l'event (cf tableau §7.1 du contrat). */
  data?: Record<string, unknown>;
  /** UUID v4 fourni par l'émetteur — clé de dédup. */
  idempotency_key: string;
  /** ISO 8601 timestamp de l'événement côté app (contrat §5.18.4). */
  occurred_at: string;
  /** Version du contrat. Doit commencer par "1." sinon log warn. */
  contract_version?: string;
}

export type WebhookHandler = (
  payload: V14WebhookPayload,
) => Promise<void> | void;

export type HandlerTable = Record<string, WebhookHandler>;

export interface ReceiverConfig {
  /** Nom court de l'app émettrice : 'notifuse', 'prospection', ... */
  app: string;
  /**
   * Valeur(s) acceptée(s) du Bearer token.
   *
   * Une `RotatingSecret` permet d'accepter simultanément la valeur courante et
   * une valeur héritée pendant une fenêtre de rotation (cf
   * `lib/webhooks/secret-rotation.ts`). La forme `string` reste acceptée et
   * équivaut à une rotation fermée (une seule valeur).
   */
  expectedToken: string | RotatingSecret;
  /** Map event_type → handler. */
  handlers: HandlerTable;
}

/** UUID v4 (laxe : on accepte aussi v1/v3/v5 — anti-typo, pas anti-crypto). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Récupère le Bearer token du header `Authorization: Bearer <token>`.
 * Renvoie null si absent ou format invalide.
 */
export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Coeur du receveur v1.4. Appelé depuis chaque route `/api/webhooks/<app>`.
 *
 * Flow :
 *  1. Vérifie Bearer token (401 si mismatch)
 *  2. Parse le body (400 si JSON invalide ou champs requis manquants)
 *  3. Tente d'insérer la row dédup (PK violation = replay → 200 idempotent)
 *  4. Dispatch via la table handlers (handler inconnu = log + 200)
 *  5. Marque processed_at au succès
 */
export async function handleWebhook(
  request: Request,
  config: ReceiverConfig,
): Promise<Response> {
  // 1. Auth Bearer — double acceptation pendant une fenêtre de rotation.
  const expected: RotatingSecret =
    typeof config.expectedToken === 'string'
      ? { current: config.expectedToken, previous: null }
      : config.expectedToken;

  const presented = extractBearer(request.headers.get('authorization'));
  if (!presented) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Missing or malformed Authorization header' },
      { status: 401 },
    );
  }

  const keyUsed = matchRotatingSecret(presented, expected);
  logWebhookAuth(config.app, 'v14-bearer', keyUsed);
  if (keyUsed === 'none') {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Invalid token' },
      { status: 401 },
    );
  }

  // 2. Body parse
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { error: 'invalid_payload', message: 'Failed to read body' },
      { status: 400 },
    );
  }

  let payload: V14WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'invalid_payload', message: 'Body is not valid JSON' },
      { status: 400 },
    );
  }

  // Validation des champs requis. On reste laxe sur `data` (events ont des
  // shapes variables, le handler dédié validera son sous-schema).
  const missing: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json(
      { error: 'invalid_payload', message: 'Body must be a JSON object' },
      { status: 400 },
    );
  }
  if (typeof payload.event !== 'string' || payload.event.length === 0) {
    missing.push('event');
  }
  if (typeof payload.tenant_id !== 'string' || payload.tenant_id.length === 0) {
    missing.push('tenant_id');
  }
  if (
    typeof payload.idempotency_key !== 'string' ||
    !UUID_RE.test(payload.idempotency_key)
  ) {
    missing.push('idempotency_key');
  }
  if (
    typeof payload.occurred_at !== 'string' ||
    payload.occurred_at.length === 0
  ) {
    missing.push('occurred_at');
  }
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: 'invalid_payload',
        message: `Missing or invalid required fields: ${missing.join(', ')}`,
        details: { fields: missing },
      },
      { status: 400 },
    );
  }

  if (payload.contract_version && !payload.contract_version.startsWith('1.')) {
    console.warn(
      `[webhook:${config.app}] unexpected contract_version=${payload.contract_version}`,
    );
  }

  // 3. Dédup : tentative d'insert atomique. Si PK violation → replay.
  try {
    await prisma.webhookDedup.create({
      data: {
        app: config.app,
        idempotencyKey: payload.idempotency_key,
        eventType: payload.event,
        payload: payload as unknown as object,
      },
    });
  } catch (err) {
    // Prisma renvoie P2002 sur PK violation. On accepte tout type d'erreur
    // d'unicité comme "replay détecté" : on relit pour confirmer et on
    // renvoie 200 idempotent.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2002') {
      const existing = await prisma.webhookDedup.findUnique({
        where: {
          app_idempotencyKey: {
            app: config.app,
            idempotencyKey: payload.idempotency_key,
          },
        },
        select: { processedAt: true },
      });
      console.info(
        `[webhook:${config.app}] dedup hit event=${payload.event} key=${payload.idempotency_key} processed=${existing?.processedAt ? 'yes' : 'pending'}`,
      );
      return NextResponse.json(
        { ok: true, deduplicated: true, processed: !!existing?.processedAt },
        { status: 200 },
      );
    }
    console.error(
      `[webhook:${config.app}] persist failed event=${payload.event}`,
      err,
    );
    return NextResponse.json(
      { error: 'internal_error', message: 'Failed to persist webhook' },
      { status: 500 },
    );
  }

  // 4. Dispatch handler
  const handler = config.handlers[payload.event];
  if (!handler) {
    console.warn(
      `[webhook:${config.app}] no handler for event=${payload.event} key=${payload.idempotency_key}`,
    );
    // On marque quand même processed pour pas re-process en boucle si le
    // handler est ajouté plus tard (sémantique : la row est "vue", pas
    // "traitée par un handler métier").
    await prisma.webhookDedup.update({
      where: {
        app_idempotencyKey: {
          app: config.app,
          idempotencyKey: payload.idempotency_key,
        },
      },
      data: { processedAt: new Date() },
    });
    return NextResponse.json(
      { ok: true, accepted: true, dispatched: false },
      { status: 200 },
    );
  }

  try {
    await handler(payload);
  } catch (err) {
    console.error(
      `[webhook:${config.app}] handler failed event=${payload.event}`,
      err,
    );
    // On NE marque PAS processed_at — la row reste re-jouable par l'app
    // au prochain retry (cf retry policy §7.1 du contrat).
    return NextResponse.json(
      { error: 'internal_error', message: 'Handler failed' },
      { status: 500 },
    );
  }

  await prisma.webhookDedup.update({
    where: {
      app_idempotencyKey: {
        app: config.app,
        idempotencyKey: payload.idempotency_key,
      },
    },
    data: { processedAt: new Date() },
  });

  return NextResponse.json(
    { ok: true, accepted: true, dispatched: true },
    { status: 200 },
  );
}
