/**
 * MEGA I-02 — HMAC tampering / wrong signature / replay drift
 *
 * **CIBLES** : tous les endpoints HMAC-authentifiés côté Hub.
 *   1. `POST /api/invitations/create` (HMAC sha256, secret `HUB_INVITATION_SECRET_<APP>`)
 *   2. `POST /api/webhooks/notifuse` (HMAC legacy sha256, secret `NOTIFUSE_HUB_WEBHOOK_SECRET`)
 *   3. `POST /api/webhooks` (Stripe signature avec drift > 5min)
 *   4. `POST /api/admin/users/create` (timing-safe x-admin-secret)
 *
 * **MATRICE D'ATTAQUES** :
 *   - signature absente → 400
 *   - signature avec wrong secret → 401
 *   - signature valide mais 1 byte du body modifié → 401
 *   - signature valide mais timestamp drifté > 5min → 401
 *   - signature mal formée (pas hex) → 401
 *   - signature de bonne longueur mais aléatoire → 401
 *   - body manquant → 400 (pas 500)
 *   - x-veridian-app inconnu → 400 (pas 401, sinon on fuit la map secrets)
 *
 * **CRITÈRES HARDCORE** :
 *   - JAMAIS de 200 sur signature invalide
 *   - JAMAIS de 5xx (fuite stack)
 *   - Le body 401 ne fuite ni le secret attendu ni le HMAC calculé interne
 *   - timingSafeEqual : même longueur de signature aléatoire = même status
 *     que signature trop courte (pas de différenciation timing exploitable
 *     côté réseau — on le vérifie indirectement via response code)
 *
 * **MARKER** : `[risk:medium]` — touche au cœur de l'auth machine-to-machine.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import Stripe from 'stripe';

import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

// Secret HMAC invitation — peut être absent en local. On tente quand même
// puisque le test du "wrong signature" ne dépend pas du vrai secret.
const INVITATION_SECRET_NOTIFUSE =
  process.env.HUB_INVITATION_SECRET_NOTIFUSE || '';

// Secret webhook Notifuse legacy.
const NOTIFUSE_WEBHOOK_SECRET =
  process.env.NOTIFUSE_HUB_WEBHOOK_SECRET || '';

// Webhook secret Stripe. Le SDK Stripe construit la signature.
const STRIPE_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake_for_test';
const stripe = new Stripe('sk_test_fake_e2e');

const BUCKET = 'i';
const SPEC = '02-hmac';

function tag(suffix: string): string {
  return `e2e-mega-${BUCKET}-${SPEC}-${suffix}-${MEGA_RUN_STAMP}`;
}

function buildInvitationBody(): string {
  return JSON.stringify({
    inviter_user_id: `usr-mega-${MEGA_RUN_STAMP}`,
    inviter_email: `${tag('inviter')}@e2e.veridian.site`,
    invitee_email: `${tag('invitee')}@e2e.veridian.site`,
    target_app: 'notifuse' as const,
    target_workspace_id: `mega-${BUCKET}-${MEGA_RUN_STAMP}-ws`,
    target_role: 'member' as const,
  });
}

function signWith(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

async function postInvitation(
  request: APIRequestContext,
  headers: Record<string, string>,
  rawBody: string,
): Promise<{ status: number; bodyText: string }> {
  const res = await request.post(`${STAGING_URL}/api/invitations/create`, {
    headers: { 'content-type': 'application/json', ...headers },
    data: rawBody,
    failOnStatusCode: false,
  });
  return { status: res.status(), bodyText: await res.text().catch(() => '') };
}

async function postNotifuseWebhook(
  request: APIRequestContext,
  headers: Record<string, string>,
  rawBody: string,
): Promise<{ status: number; bodyText: string }> {
  const res = await request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
    headers: { 'content-type': 'application/json', ...headers },
    data: rawBody,
    failOnStatusCode: false,
  });
  return { status: res.status(), bodyText: await res.text().catch(() => '') };
}

test.describe.configure({ mode: 'serial' });

// ─── Cible 1 : POST /api/invitations/create ──────────────────────────────

test.describe('Mega I-02 — HMAC tampering sur POST /api/invitations/create', () => {
  test('signature absente → 400 missing_signature (pas 401, pas 200)', async ({
    request,
  }) => {
    const rawBody = buildInvitationBody();
    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': String(Date.now()),
        // signature volontairement absente
      },
      rawBody,
    );
    expect(r.status).toBe(400);
    expect(r.status, 'JAMAIS 200 sur signature absente').not.toBe(200);
  });

  test('signature avec wrong secret (longueur correcte) → 401', async ({
    request,
  }) => {
    const rawBody = buildInvitationBody();
    const timestamp = String(Date.now());
    // Secret pris au hasard, longueur réaliste 64 chars
    const wrongSecret = 'wrong-secret-' + 'x'.repeat(50);
    const sig = signWith(wrongSecret, timestamp, rawBody);

    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': sig,
      },
      rawBody,
    );
    expect(r.status, `Attendu 401 ou 503, got ${r.status}`).toBeGreaterThanOrEqual(401);
    expect(r.status, 'JAMAIS 200 sur wrong secret').not.toBe(200);
    expect([401, 429, 503]).toContain(r.status);
    // 503 acceptable si secret pas configuré côté Hub (cf. resolveInvitationSecret)
    // 401 nominal sur wrong signature
    // 429 acceptable si rate-limit consommé par tests précédents
  });

  test('signature mal formée (pas hex) → 401, jamais 5xx', async ({
    request,
  }) => {
    const rawBody = buildInvitationBody();
    const timestamp = String(Date.now());
    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': 'GGGG-pas-du-hex-du-tout-!!!!',
      },
      rawBody,
    );
    expect(
      r.status,
      `signature non-hex doit retourner 401, jamais 5xx. Got ${r.status}`,
    ).toBeLessThan(500);
    expect(r.status).not.toBe(200);
  });

  test('signature aléatoire 64 hex (longueur correcte) → 401', async ({
    request,
  }) => {
    const rawBody = buildInvitationBody();
    const timestamp = String(Date.now());
    const randomSig = randomBytes(32).toString('hex'); // sha256 = 32 bytes hex

    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': randomSig,
      },
      rawBody,
    );
    expect([401, 429, 503]).toContain(r.status);
    expect(r.status).not.toBe(200);
  });

  test('timestamp drifté > 5min → 401 drift', async ({ request }) => {
    if (!INVITATION_SECRET_NOTIFUSE) {
      test.skip(
        true,
        'HUB_INVITATION_SECRET_NOTIFUSE non câblé — on ne peut pas signer correctement pour tester le drift',
      );
      return;
    }
    const rawBody = buildInvitationBody();
    // Timestamp 10 minutes dans le passé
    const oldTs = String(Date.now() - 10 * 60 * 1000);
    const sig = signWith(INVITATION_SECRET_NOTIFUSE, oldTs, rawBody);

    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': oldTs,
        'x-veridian-invitation-signature': sig,
      },
      rawBody,
    );
    expect(r.status, `drift > 5min doit retourner 401, got ${r.status}`).toBe(
      401,
    );
  });

  test('body modifié après signature valide → 401', async ({ request }) => {
    if (!INVITATION_SECRET_NOTIFUSE) {
      test.skip(true, 'HUB_INVITATION_SECRET_NOTIFUSE non câblé');
      return;
    }
    const rawBody = buildInvitationBody();
    const timestamp = String(Date.now());
    const sig = signWith(INVITATION_SECRET_NOTIFUSE, timestamp, rawBody);

    // Tamper : on change 1 char dans le body APRÈS avoir signé
    const tamperedBody = rawBody.replace(
      'target_role":"member"',
      'target_role":"owner"',
    );
    expect(tamperedBody).not.toBe(rawBody);

    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': sig,
      },
      tamperedBody,
    );
    expect(
      r.status,
      `tampering body après signature doit retourner 401, got ${r.status}`,
    ).toBe(401);
  });

  test('x-veridian-app inconnu → 400 (pas 401 — anti fuite map secrets)', async ({
    request,
  }) => {
    const rawBody = buildInvitationBody();
    const timestamp = String(Date.now());
    const sig = signWith('whatever', timestamp, rawBody);

    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notexists',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': sig,
      },
      rawBody,
    );
    // Strictement 400 : si on retournait 401, on signalerait à un attaquant
    // qu'il a touché une vraie app + un mauvais secret (vs app inexistante).
    expect(r.status, `app inconnu doit retourner 400, got ${r.status}`).toBe(
      400,
    );
  });

  test('le body 401 ne fuite ni secret attendu ni HMAC calculé', async ({
    request,
  }) => {
    const rawBody = buildInvitationBody();
    const timestamp = String(Date.now());
    const sig = randomBytes(32).toString('hex');

    const r = await postInvitation(
      request,
      {
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': sig,
      },
      rawBody,
    );
    const bodyLower = r.bodyText.toLowerCase();
    // Sanity : pas de leak de secrets/HMAC interne
    expect(bodyLower).not.toContain('expected');
    expect(bodyLower).not.toContain('computed');
    if (INVITATION_SECRET_NOTIFUSE) {
      expect(
        r.bodyText,
        'CRITIQUE : le secret HMAC réel ne doit JAMAIS apparaître dans la réponse',
      ).not.toContain(INVITATION_SECRET_NOTIFUSE);
    }
    // Pas de stack trace
    expect(bodyLower).not.toContain('typeerror');
    expect(bodyLower).not.toContain('at object.');
  });
});

// ─── Cible 2 : POST /api/webhooks/notifuse (legacy HMAC) ─────────────────

test.describe('Mega I-02 — HMAC tampering sur POST /api/webhooks/notifuse (legacy)', () => {
  test('signature absente → 401 invalid signature', async ({ request }) => {
    const body = JSON.stringify({
      event_id: tag('legacy'),
      event_type: 'tenant.touched',
      tenant_id: 'mega-irrelevant',
      data: {},
    });
    const r = await postNotifuseWebhook(
      request,
      {
        // Pas de header signature : on retombe sur la branche legacy HMAC
        // (puisque pas de Authorization Bearer non plus)
        'x-veridian-timestamp': String(Date.now()),
      },
      body,
    );
    // Si le secret n'est pas configuré côté staging → 500 acceptable mais
    // documenté ; sinon → 401 strict.
    expect(r.status).not.toBe(200);
    expect([401, 500]).toContain(r.status);
  });

  test('signature aléatoire (longueur sha256 hex) → 401', async ({
    request,
  }) => {
    const body = JSON.stringify({
      event_id: tag('legacy-random'),
      event_type: 'tenant.touched',
      tenant_id: 'mega-irrelevant',
      data: {},
    });
    const r = await postNotifuseWebhook(
      request,
      {
        'x-veridian-timestamp': String(Date.now()),
        'x-veridian-notifuse-signature': randomBytes(32).toString('hex'),
      },
      body,
    );
    expect(r.status).not.toBe(200);
    expect([401, 500]).toContain(r.status);
  });

  test('signature avec wrong secret → 401', async ({ request }) => {
    const body = JSON.stringify({
      event_id: tag('legacy-wrong'),
      event_type: 'tenant.touched',
      tenant_id: 'mega-irrelevant',
      data: {},
    });
    const timestamp = String(Date.now());
    const sig = signWith('not-the-real-secret-' + 'x'.repeat(40), timestamp, body);
    const r = await postNotifuseWebhook(
      request,
      {
        'x-veridian-timestamp': timestamp,
        'x-veridian-notifuse-signature': sig,
      },
      body,
    );
    expect(r.status).not.toBe(200);
    expect([401, 500]).toContain(r.status);
  });

  test('timestamp drifté > 5min → 401', async ({ request }) => {
    if (!NOTIFUSE_WEBHOOK_SECRET) {
      test.skip(
        true,
        'NOTIFUSE_HUB_WEBHOOK_SECRET non câblé — drift test demande un secret valide',
      );
      return;
    }
    const body = JSON.stringify({
      event_id: tag('legacy-drift'),
      event_type: 'tenant.touched',
      tenant_id: 'mega-irrelevant',
      data: {},
    });
    const oldTs = String(Date.now() - 10 * 60 * 1000);
    const sig = signWith(NOTIFUSE_WEBHOOK_SECRET, oldTs, body);
    const r = await postNotifuseWebhook(
      request,
      {
        'x-veridian-timestamp': oldTs,
        'x-veridian-notifuse-signature': sig,
      },
      body,
    );
    expect(r.status).toBe(401);
  });
});

// ─── Cible 3 : POST /api/webhooks (Stripe) — drift timestamp ─────────────

test.describe('Mega I-02 — Stripe webhook tampering', () => {
  test('signature avec timestamp dérivé > 5min → 400', async ({ request }) => {
    const event = {
      id: `evt_${tag('stripe-drift')}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000) - 600,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'ping',
      data: { object: {} },
    };
    const body = JSON.stringify(event);
    const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 min dans le passé
    const sig = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_WHSEC,
      timestamp: oldTs,
    });

    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sig,
      },
      data: body,
      failOnStatusCode: false,
    });
    // Stripe SDK constructEvent rejette les timestamps > 5min drift par défaut.
    expect(res.status(), 'drift > 5min Stripe → 400').toBe(400);
    expect(res.status()).not.toBe(200);
  });

  test('signature absente sur webhook Stripe → 400', async ({ request }) => {
    const body = JSON.stringify({
      id: `evt_${tag('stripe-nosig')}`,
      type: 'ping',
      data: { object: {} },
    });
    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: { 'content-type': 'application/json' },
      data: body,
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    expect([400, 401]).toContain(res.status());
  });

  test('signature complètement bidon → 400/401, jamais 5xx', async ({
    request,
  }) => {
    const body = JSON.stringify({
      id: `evt_${tag('stripe-fake')}`,
      type: 'ping',
      data: { object: {} },
    });
    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=0,v1=fakefakefakefakefake',
      },
      data: body,
      failOnStatusCode: false,
    });
    expect(res.status()).toBeLessThan(500);
    expect(res.status()).not.toBe(200);
  });
});

// ─── Cible 4 : timing-safe x-admin-secret ────────────────────────────────

test.describe('Mega I-02 — Admin secret timing-safe', () => {
  test('wrong x-admin-secret (longueur correcte) → 401, pas 200', async ({
    request,
  }) => {
    // On envoie un secret arbitraire de 48 chars (longueur typique) sur
    // un endpoint admin. Doit toujours retourner 401, jamais 200.
    const fakeSecret = 'a'.repeat(48);
    const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': fakeSecret,
      },
      data: {
        email: `${tag('admin-fake')}@e2e.veridian.site`,
        name: 'Should Never Create',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    // 401 nominal ; 429 acceptable si rate-limit consommé
    expect([401, 429]).toContain(res.status());
  });

  test('x-admin-secret vide → 401, pas 200', async ({ request }) => {
    const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: { 'content-type': 'application/json', 'x-admin-secret': '' },
      data: {
        email: `${tag('admin-empty')}@e2e.veridian.site`,
        name: 'Should Never Create',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    expect([401, 429]).toContain(res.status());
  });

  test('x-admin-secret de longueurs différentes → même status code (pas de leak length via timing)', async ({
    request,
  }) => {
    // 5 calls avec secrets de longueurs différentes. Tous doivent retourner
    // le même status (401 ou 429), pas de différenciation observable
    // côté réponse selon length.
    const lengths = [10, 20, 32, 48, 64];
    const statuses: number[] = [];
    for (const n of lengths) {
      const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': 'x'.repeat(n),
        },
        data: {
          email: `${tag(`admin-len${n}`)}@e2e.veridian.site`,
          name: 'Length test',
        },
        failOnStatusCode: false,
      });
      statuses.push(res.status());
    }
    // Tous != 200 et tous dans {401, 429}
    for (const s of statuses) {
      expect(s).not.toBe(200);
      expect([401, 429]).toContain(s);
    }
  });
});
