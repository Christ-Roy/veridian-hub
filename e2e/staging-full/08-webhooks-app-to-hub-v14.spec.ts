/**
 * Journey 8 — Webhooks v1.4 app → Hub (receiver factorisé).
 *
 * **CONTEXTE** : depuis le sprint v1.4 (2026-05-21), les apps downstream
 * peuvent émettre des events vers le Hub via :
 *   - POST /api/webhooks/notifuse (Bearer NOTIFUSE_WEBHOOK_TOKEN, v1.4)
 *   - POST /api/webhooks/prospection (Bearer PROSPECTION_WEBHOOK_TOKEN, v1.4)
 *
 * **CE QUE CE SPEC COUVRE** :
 *   1. Bearer manquant / bidon → 401
 *   2. Body sans champs requis → 400
 *   3. event valide avec handler stub (`tenant.touched`) → 200 dispatched=true
 *   4. event SANS handler enregistré → 200 dispatched=false (accepté + persisté)
 *   5. Replay même idempotency_key → 200 deduplicated
 *   6. `tenant.activity_threshold_reached` (trial signal) → 200 dispatched=true
 *   7. Bearer Prospection sur route Notifuse → 401 (tokens distincts)
 *
 * **GARDE-FOU SÉCU** : on vérifie que le receiver ne fuit JAMAIS de
 * détails internes (pas de stack trace, pas d'env var name dans le body
 * d'erreur).
 *
 * **DÉPENDANCES** :
 *   - NOTIFUSE_WEBHOOK_TOKEN et PROSPECTION_WEBHOOK_TOKEN injectés en staging
 *     via GitHub secrets → workflow → .env → compose env_file
 *   - Table `hub_app.webhook_dedup` (PK app+idempotency_key)
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const STAGING_URL = process.env.STAGING_URL || 'https://hub.staging.veridian.site';

// Récupéré via `ssh dev-pub 'docker exec hub-staging env'` (cf. brief).
// Ces valeurs sont injectées par la CI staging depuis les secrets GitHub.
// Les fallbacks ci-dessous sont VOLONTAIREMENT factices : un secret réel ne
// doit jamais figurer dans un fichier versionné (ce dépôt est public).
// Sans injection, ces specs échouent en 401 — c'est le comportement voulu.
const NOTIFUSE_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  'FAKE-e2e-notifuse-webhook-token-do-not-use-in-prod';
const PROSPECTION_TOKEN =
  process.env.PROSPECTION_WEBHOOK_TOKEN ||
  'FAKE-e2e-prospection-webhook-token-do-not-use-in-prod';

function v14Payload(
  event: string,
  tenantId = `tenant-${Date.now()}`,
  extra: Record<string, unknown> = {},
) {
  return {
    event,
    tenant_id: tenantId,
    idempotency_key: randomUUID(),
    occurred_at: new Date().toISOString(),
    contract_version: '1.4',
    data: extra,
  };
}

async function postNotifuse(
  request: APIRequestContext,
  body: unknown,
  authOverride?: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authOverride === null) {
    // pas de header
  } else if (authOverride !== undefined) {
    headers.authorization = authOverride;
  } else {
    headers.authorization = `Bearer ${NOTIFUSE_TOKEN}`;
  }
  return request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
    headers,
    data: body,
    failOnStatusCode: false,
  });
}

async function postProspection(
  request: APIRequestContext,
  body: unknown,
  authOverride?: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authOverride === null) {
  } else if (authOverride !== undefined) {
    headers.authorization = authOverride;
  } else {
    headers.authorization = `Bearer ${PROSPECTION_TOKEN}`;
  }
  return request.post(`${STAGING_URL}/api/webhooks/prospection`, {
    headers,
    data: body,
    failOnStatusCode: false,
  });
}

// ─── Auth ────────────────────────────────────────────────────────────────

test.describe('Journey 8 — Webhook receiver v1.4 auth', () => {
  test('Notifuse sans Authorization → 401 (jamais 500, secret toujours présent en staging)', async ({ request }) => {
    const res = await postNotifuse(request, v14Payload('tenant.touched'), null);
    // DURCI 2026-05-23 (ticket e2e-harden-tolerances) :
    // L'ancienne tolérance `[400, 401, 500]` cachait un défaut de
    // configuration (secret manquant côté staging). Maintenant le secret
    // NOTIFUSE_WEBHOOK_TOKEN est obligatoirement présent en staging
    // (sourcé par scripts/e2e/staging-full.sh + injecté côté Hub). Un 500
    // ici = vraie régression de config à fixer.
    expect(
      [400, 401],
      `Webhook sans auth doit être rejeté 400/401 (got ${res.status()}). ` +
        `Un 500 = NOTIFUSE_WEBHOOK_TOKEN manquant côté Hub, fix la config.`,
    ).toContain(res.status());
    expect(
      res.status(),
      'CRITIQUE : un webhook sans auth ne doit JAMAIS retourner 200',
    ).not.toBe(200);
  });

  test('Notifuse Bearer bidon → 401', async ({ request }) => {
    const res = await postNotifuse(
      request,
      v14Payload('tenant.touched'),
      'Bearer totally-wrong-token',
    );
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    // Garde-fou : pas de fuite d'info sensible dans le body.
    expect(JSON.stringify(body).toLowerCase()).not.toContain(
      'notifuse_webhook_token',
    );
  });

  test('Prospection Bearer Notifuse → 401 (tokens distincts par app)', async ({
    request,
  }) => {
    const res = await postProspection(
      request,
      v14Payload('tenant.touched'),
      `Bearer ${NOTIFUSE_TOKEN}`,
    );
    expect(
      res.status(),
      'token notifuse NE doit PAS être accepté sur la route prospection',
    ).toBe(401);
  });
});

// ─── Body validation ─────────────────────────────────────────────────────

test.describe('Journey 8 — Body validation', () => {
  test('JSON invalide → 400', async ({ request }) => {
    const res = await request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
      headers: {
        authorization: `Bearer ${NOTIFUSE_TOKEN}`,
        'content-type': 'application/json',
      },
      data: '{not valid json',
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test('champs requis manquants → 400 invalid_payload', async ({ request }) => {
    const res = await postNotifuse(request, {
      // pas de event ni tenant_id ni idempotency_key
      foo: 'bar',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
    expect(Array.isArray(body.details?.fields)).toBe(true);
  });

  test('idempotency_key pas UUID → 400', async ({ request }) => {
    const res = await postNotifuse(request, {
      event: 'tenant.touched',
      tenant_id: 'wks_42',
      idempotency_key: 'not-a-uuid',
      occurred_at: new Date().toISOString(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });
});

// ─── Happy path + idempotence ────────────────────────────────────────────

test.describe('Journey 8 — Happy path + idempotence', () => {
  test('Notifuse tenant.touched (handler stub) → 200 dispatched=true', async ({
    request,
  }) => {
    const payload = v14Payload('tenant.touched', 'wks-e2e-notif-1', {
      activity_count: 12,
    });
    const res = await postNotifuse(request, payload);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dispatched).toBe(true);
  });

  test('Notifuse event SANS handler → 200 dispatched=false (accepté+persisté)', async ({
    request,
  }) => {
    const payload = v14Payload('custom.unhandled.event', 'wks-e2e-notif-2');
    const res = await postNotifuse(request, payload);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Contract : event inconnu = accepted+persisted, juste pas dispatched.
    expect(body.dispatched).toBe(false);
    expect(body.accepted).toBe(true);
  });

  test('replay même idempotency_key → 200 deduplicated', async ({ request }) => {
    const payload = v14Payload(
      'tenant.touched',
      `wks-e2e-replay-${Date.now()}`,
    );
    const first = await postNotifuse(request, payload);
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.deduplicated).not.toBe(true);

    const second = await postNotifuse(request, payload);
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(
      secondBody.deduplicated,
      'replay même idempotency_key DOIT être dedup',
    ).toBe(true);
  });

  test('tenant.activity_threshold_reached (signal trial) → 200 dispatched=true', async ({
    request,
  }) => {
    const payload = v14Payload(
      'tenant.activity_threshold_reached',
      'wks-e2e-trial-1',
      {
        threshold: 100,
        current: 105,
      },
    );
    const res = await postNotifuse(request, payload);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.dispatched).toBe(true);
  });

  test('Prospection happy path tenant.touched', async ({ request }) => {
    const payload = v14Payload('tenant.touched', 'wks-e2e-prosp-1');
    const res = await postProspection(request, payload);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
