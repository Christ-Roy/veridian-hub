/**
 * GET /api/tenants/{tenantId}/billing-state
 *
 * Endpoint POLL de réconciliation billing pour les apps downstream.
 * Spec : `docs/CONTRAT-BILLING.md` §6.3.
 *
 * Flow :
 *   1. Rate-limit 60 req/min/secret (clé = app HMAC, pas IP — un même
 *      secret partage le bucket).
 *   2. Vérif HMAC Pattern A §6.1 : `X-Veridian-Hub-Signature` +
 *      `X-Veridian-Timestamp` + `x-veridian-app`, drift max 5 min, secret
 *      canonique `<APP>_HUB_API_SECRET`.
 *   3. Lecture (avec cache 10s TTL) — DB Hub source de vérité.
 *   4. Réponse minimaliste shape §6.3 (pas plus de champs sans bump de
 *      contract_version).
 *
 * Privacy / isolation :
 *   - L'app appelante ne peut récupérer QUE l'état billing concernant son
 *     propre app (notifuse caller → notifuse plan, prospection caller →
 *     prospection plan). Le champ `app` est dérivé du header HMAC
 *     `x-veridian-app`, jamais lu depuis l'URL ou un body. Une app qui
 *     usurpe x-veridian-app=X échoue au check signature (secret désync).
 *
 * Idempotent, lecture seule, hors hot path utilisateur.
 */

import { NextResponse } from 'next/server';

import { billingStatePollLimiter } from '@/lib/auth/rate-limit';
import { getBillingState } from '@/lib/billing/billing-state';
import { verifyBillingStateHmac } from '@/lib/billing/billing-state-hmac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ tenantId: string }> },
) {
  // HMAC d'abord pour pouvoir keyer le rate-limit sur l'app authentifiée.
  // Pour un GET, le rawBody signé est la string vide (Pattern A est
  // tolérant — la signature couvre `${timestamp}.${rawBody}` même si
  // rawBody=='').
  const hmac = verifyBillingStateHmac(request.headers, '');
  if (!hmac.ok) {
    return NextResponse.json(
      { error: 'unauthorized', reason: hmac.reason },
      { status: hmac.status },
    );
  }

  // Rate-limit clé par app HMAC (token-equivalent). Permet jusqu'à 60
  // req/min/app — adapté à un cron de réconciliation un peu agressif.
  // enforceWithBypass : bypass E2E staging via header secret valide
  // (cf. lib/auth/rate-limit.ts). En prod le bypass est ignoré.
  const rate = billingStatePollLimiter.enforceWithBypass(
    `app:${hmac.app}`,
    request.headers,
  );
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }

  const params = await ctx.params;
  const tenantId = params.tenantId?.trim();

  // Validation tenant_id : UUID v4 obligatoire (les tenants Hub sont
  // tous des UUID Prisma). Refuser early avec 400, pas 404 — 404 dirait
  // "n'existe pas en DB" alors qu'on n'a même pas regardé.
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    return NextResponse.json(
      { error: 'invalid_tenant_id', reason: 'tenant_id must be a UUID' },
      { status: 400 },
    );
  }

  const result = await getBillingState(tenantId, hmac.app);

  if (!result.ok) {
    if (result.error.code === 'tenant_not_found') {
      return NextResponse.json(
        { error: 'tenant_not_found' },
        { status: 404 },
      );
    }
    // unknown_plan : 500 + log (état corrompu côté Hub, pas faute du caller).
    console.error(
      JSON.stringify({
        tag: '[billing-state][error]',
        level: 'error',
        tenant_id: tenantId,
        app: hmac.app,
        code: result.error.code,
        details: result.error.details,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: 'internal_error', reason: 'plan resolution failed' },
      { status: 500 },
    );
  }

  // Header de debug optionnel pour observabilité — pas spec'd dans le
  // contrat, ne contredit rien (les apps ignorent les headers inconnus).
  const headers = new Headers({ 'X-Veridian-Cache': result.cached ? 'HIT' : 'MISS' });

  return NextResponse.json(result.response, { status: 200, headers });
}
