/**
 * Prod smoke — Sprint v1.4 endpoints.
 *
 * **OBJECTIF** : valider POST-DEPLOY que les nouvelles routes du sprint v1.4
 * (Stripe webhook orchestrator, webhooks app→Hub, invitations cross-app)
 * sont câblées en prod et que leurs prérequis (ENV, migrations DB) sont
 * bien en place. La SEULE chose qu'on veut catcher : une 500 silencieuse
 * post-deploy qui signalerait :
 *   - Migration Prisma manquante (CrossAppInvitation, StripeEvent, WebhookDedup)
 *   - ENV oubliée (NOTIFUSE_WEBHOOK_TOKEN, STRIPE_WEBHOOK_SECRET, etc.)
 *   - Bug imprévu lors du parsing input / auth header
 *
 * **STRATÉGIE** : tests 100% read-only, zéro écriture DB, zéro signup.
 * Chaque test envoie une requête volontairement invalide (sig bidon,
 * header manquant) et asserte sur le code HTTP attendu (4xx) + le fait
 * que le code N'EST PAS 500.
 *
 * Si un de ces tests fail → rollback prod auto (cf hub-ci.yml). Le smoke
 * staging est conservé identique côté staging, mais c'est ce spec qui
 * fait office de filet final.
 *
 * Lancé par hub-ci.yml job `e2e-prod-smoke` après deploy main → prod
 * (commande `npx playwright test e2e/prod-smoke/` qui pick up tout le
 * dossier — pas besoin de modifier la commande CI).
 */
import { test, expect } from '@playwright/test';

// Hard-coded prod URL by design (même règle qu'auth-prod.spec.ts) : ce spec
// DOIT toujours hit app.veridian.site, jamais staging, même si HUB_URL est
// surchargé.
const PROD_HUB_URL = 'https://app.veridian.site';

/**
 * Helper qui asserte qu'un code HTTP N'EST PAS 5xx. Un 5xx en prod sur ces
 * routes = migration manquante ou ENV manquante = ROLLBACK obligatoire.
 *
 * On accepte un set de codes 4xx attendus (variation selon état ENV/DB).
 */
function expectClientError(
  status: number,
  acceptedCodes: number[],
  routeLabel: string,
) {
  expect(
    status,
    `prod ${routeLabel} returned ${status}. ` +
      `5xx = migration ou ENV manquante en prod = ROLLBACK. ` +
      `Accepted client errors: ${acceptedCodes.join(', ')}`,
  ).toBeLessThan(500);
  expect(
    acceptedCodes,
    `prod ${routeLabel} returned ${status}, expected one of ${acceptedCodes.join(', ')}`,
  ).toContain(status);
}

test.describe('Hub PROD sprint v1.4 — Stripe webhook orchestrator', () => {
  // Refacto 2026-05-21 : table hub_app.stripe_events + dispatcher idempotent.
  // Si la migration 20260521120000_add_stripe_events_and_user_customer_id
  // n'a PAS été appliquée en prod, persistStripeEvent throw → on log + on
  // continue à dispatch → si dispatch retourne 'ignored' pour un event
  // fake, on renvoie 200. Donc le 500 ne survient que sur des chemins
  // upstream. C'est pour ça que le test cible la sig invalide (400 sûr).

  test('POST /api/webhooks without stripe-signature → 400 (route alive, secret check works)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/webhooks`, {
      data: '{"id":"evt_test","type":"ping"}',
      headers: { 'content-type': 'application/json' },
    });
    expectClientError(res.status(), [400], 'POST /api/webhooks (no signature)');
  });

  test('POST /api/webhooks with bogus stripe-signature → 400 (constructEvent rejects)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/webhooks`, {
      data: '{"id":"evt_test","type":"ping"}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1234,v1=deadbeef',
      },
    });
    // 400 : signature verification failed branch.
    expectClientError(
      res.status(),
      [400],
      'POST /api/webhooks (bogus signature)',
    );
  });
});

test.describe('Hub PROD sprint v1.4 — Webhooks app → Hub (Bearer v1.4)', () => {
  // Routes /api/webhooks/notifuse et /api/webhooks/prospection (v1.4 bearer).
  // Le receiver `lib/webhooks/receiver.ts` exige Bearer token + payload v1.4.
  // Si ENV NOTIFUSE_WEBHOOK_TOKEN ou PROSPECTION_WEBHOOK_TOKEN n'est PAS set
  // en prod, on tombe sur 500 "<APP>_WEBHOOK_TOKEN not configured" — c'est
  // exactement ce qu'on veut éviter (ENV propagation prod du sprint v1.4).
  //
  // NOTE : POST /api/webhooks/notifuse sans header `authorization` retombe
  // sur le legacy HMAC handler (rétro-compatibilité Notifuse fork). Sans
  // header HMAC il retourne 401 ("Invalid signature"). Donc 401 prouve aussi
  // que la route et son ENV legacy (NOTIFUSE_HUB_WEBHOOK_SECRET) sont OK.

  test('POST /api/webhooks/notifuse without auth → 401 (route alive, no 500 = ENV configured)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/webhooks/notifuse`, {
      data: '{}',
      headers: { 'content-type': 'application/json' },
    });
    // Sans header `authorization`, on tombe sur legacy → verifyLegacySignature
    // false → 401. Si ENV NOTIFUSE_HUB_WEBHOOK_SECRET manquait → 500.
    expectClientError(
      res.status(),
      [401],
      'POST /api/webhooks/notifuse (no auth)',
    );
  });

  test('POST /api/webhooks/notifuse with bogus Bearer → 401 (token mismatch)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/webhooks/notifuse`, {
      data: JSON.stringify({
        event: 'tenant.touched',
        tenant_id: 'fake',
        idempotency_key: '00000000-0000-4000-8000-000000000000',
        emitted_at: new Date().toISOString(),
      }),
      headers: {
        'content-type': 'application/json',
        // Bearer présent → branche v1.4 → si NOTIFUSE_WEBHOOK_TOKEN
        // missing → 500. Avec ENV présente → constantTimeEquals false → 401.
        authorization: 'Bearer bogus-token-veridian-smoke',
      },
    });
    expectClientError(
      res.status(),
      [401],
      'POST /api/webhooks/notifuse (bogus Bearer)',
    );
  });

  test('POST /api/webhooks/prospection without auth → 401 (route alive)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/webhooks/prospection`, {
      data: '{}',
      headers: { 'content-type': 'application/json' },
    });
    // Pas de fallback legacy ici — la route exige toujours Bearer.
    // Sans header → extractBearer(null) → 401. Si PROSPECTION_WEBHOOK_TOKEN
    // manquait → 500. Donc 401 = ENV OK + route OK.
    expectClientError(
      res.status(),
      [401],
      'POST /api/webhooks/prospection (no auth)',
    );
  });

  test('POST /api/webhooks/prospection with bogus Bearer → 401', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/webhooks/prospection`, {
      data: JSON.stringify({
        event: 'tenant.touched',
        tenant_id: 'fake',
        idempotency_key: '00000000-0000-4000-8000-000000000000',
        emitted_at: new Date().toISOString(),
      }),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bogus-token-veridian-smoke',
      },
    });
    expectClientError(
      res.status(),
      [401],
      'POST /api/webhooks/prospection (bogus Bearer)',
    );
  });
});

test.describe('Hub PROD sprint v1.4 — Invitations cross-app (HMAC + session)', () => {
  // Routes :
  //   - POST /api/invitations/create        (HMAC machine-to-machine)
  //   - GET  /api/invitations/[token]/verify (public, lookup)
  //   - POST /api/invitations/[token]/accept (session Hub requise)
  //
  // Si la migration 20260520210000_add_cross_app_invitations n'est PAS
  // appliquée en prod, les routes vont 500 dès qu'elles touchent
  // crossAppInvitation.findUnique / .create. Les tests ci-dessous évitent
  // d'atteindre ce code path en se faisant rejeter dès l'auth/HMAC, MAIS
  // si l'auth check échoue lui-même à cause d'un crash de chargement
  // d'env / module → 500 → on catch.

  test('POST /api/invitations/create without x-veridian-app → 400 (route alive, HMAC verifier works)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/invitations/create`, {
      data: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    // verifyInvitationHmac retourne reason='missing x-veridian-app', status=400.
    // Sinon on serait soit en 401 (HMAC fail) soit en 503 (secret pas configuré).
    // 400 = chemin garanti (pas dépendant d'ENV optionnelle).
    expectClientError(
      res.status(),
      [400],
      'POST /api/invitations/create (no x-veridian-app)',
    );
  });

  test('POST /api/invitations/create with bogus HMAC headers → 401 or 503 (route alive, no 500)', async ({
    request,
  }) => {
    const res = await request.post(`${PROD_HUB_URL}/api/invitations/create`, {
      data: JSON.stringify({
        inviter_user_id: 'fake',
        inviter_email: 'fake@example.test',
        invitee_email: 'invitee@example.test',
        target_app: 'notifuse',
        target_workspace_id: 'fake-ws',
      }),
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': String(Date.now()),
        'x-veridian-invitation-signature': 'deadbeef',
      },
    });
    // Selon état ENV prod :
    //   - HUB_INVITATION_SECRET_NOTIFUSE configuré → 401 (sig mismatch)
    //   - HUB_INVITATION_SECRET_NOTIFUSE absent    → 503 (not configured)
    // Les 2 sont OK : pas de 500, route câblée.
    expectClientError(
      res.status(),
      [401, 503],
      'POST /api/invitations/create (bogus HMAC)',
    );
  });

  test('POST /api/invitations/[token]/accept without session → 401 (route alive)', async ({
    request,
  }) => {
    // Token volontairement valide format (64 hex) pour traverser la
    // validation format ; le check de session vient AVANT le lookup DB
    // donc on n'atteint pas crossAppInvitation.findUnique. Pas de 500
    // possible sauf si auth() lui-même crash (= problème Auth.js / Prisma
    // global = on veut catch).
    const fakeToken = 'a'.repeat(64);
    const res = await request.post(
      `${PROD_HUB_URL}/api/invitations/${fakeToken}/accept`,
      {
        data: '{}',
        headers: { 'content-type': 'application/json' },
      },
    );
    expectClientError(
      res.status(),
      [401],
      'POST /api/invitations/[token]/accept (no session)',
    );
  });

  test('GET /api/invitations/[token]/verify with bogus token → 404 (route alive, format check works)', async ({
    request,
  }) => {
    // Token format invalide (pas 64 hex) → court-circuit avant DB lookup.
    // Confirme que la route Next.js est bien servie et que TOKEN_FORMAT
    // regex fonctionne. Si la route plante au boot (mauvaise import) →
    // 500. Si la migration crossAppInvitation manque MAIS qu'on n'atteint
    // pas la DB → toujours 404 propre.
    const res = await request.get(
      `${PROD_HUB_URL}/api/invitations/bogus-not-hex/verify`,
    );
    expectClientError(
      res.status(),
      [404],
      'GET /api/invitations/[token]/verify (invalid format)',
    );
  });

  test('GET /api/invitations/[token]/verify with valid format but unknown token → 404 (table exists, lookup works)', async ({
    request,
  }) => {
    // Token format valide (64 hex) → DB lookup réel sur crossAppInvitation.
    // Si la migration 20260520210000_add_cross_app_invitations n'est PAS
    // appliquée en prod, prisma.crossAppInvitation.findUnique va throw
    // "relation hub_app.cross_app_invitations does not exist" → 500.
    // C'est LE test qui catch l'absence de la migration sprint v1.4.
    const fakeToken = 'b'.repeat(64);
    const res = await request.get(
      `${PROD_HUB_URL}/api/invitations/${fakeToken}/verify`,
    );
    expectClientError(
      res.status(),
      [404],
      'GET /api/invitations/[token]/verify (unknown token — proves cross_app_invitations table exists)',
    );
  });
});
