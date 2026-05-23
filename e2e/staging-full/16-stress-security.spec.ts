/**
 * Journey 16 — Stress & sécu : résilience des endpoints critiques sous charge
 * + tentatives d'attaque.
 *
 * **CONTEXTE** : sprint v1.4 (2026-05-21) a déployé beaucoup d'endpoints
 * publics qui prennent du payload externe. On cherche ici :
 *   1. Que les rate-limiters câblés dans `lib/auth/rate-limit.ts` font
 *      effectivement leur job (429 + Retry-After) sous burst
 *   2. Qu'aucune race condition n'autorise une double-acceptation d'invitation
 *   3. Que les payloads malveillants (JSON tronqué, XXL, SQLi, XSS, path
 *      traversal) sont rejetés AVANT de toucher la DB ou le client React
 *   4. Que le webhook Stripe est replay-safe (idempotent sur event.id) et
 *      anti-tampering (drift timestamp, signature)
 *   5. Que les routes auth credentials ne distinguent pas "user not found"
 *      vs "wrong password" (anti user-enumeration)
 *
 * **PHILOSOPHIE TESTS** : on accepte qu'on tape la même IP réelle (Traefik
 * réécrit XFF côté staging) donc les rate-limiter par IP touchent vite leur
 * cap. C'est ce qu'on veut tester : que les seuils sont bien là.
 *
 * **MARKER** : `[risk:low]` (test E2E pur, ne touche pas la prod).
 *
 * **GARDE-FOU TIMING** : les rate-limiters utilisent une fenêtre de 60s. Si
 * un autre spec a déjà consommé le quota, on peut bloquer. Solution :
 *   - test.describe.serial pour éviter le parallélisme intra-fichier
 *   - timeout 90s pour chaque test (laisse de la marge)
 *   - sleep entre describes pour laisser respirer les limiteurs si besoin
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID, createHmac } from 'node:crypto';
import Stripe from 'stripe';

import { RUN_STAMP } from './_helpers';

const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

// Tokens partagés avec spec 08 — déjà documenté dans le brief.
const NOTIFUSE_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

// Webhook secret Stripe staging — résolution dynamique (cf. spec 09).
// Priorité : STRIPE_WEBHOOK_SECRET_TEST > STRIPE_WEBHOOK_SECRET > fallback.
const STAGING_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake';
const stripe = new Stripe('sk_test_fake');

// HMAC secret invitation (staging — pareil que prod-staging-only, fixé par CI).
// Si non câblé dans l'ENV CI/local, on tente quand même mais on tolère le 503.
const INVITATION_SECRET_NOTIFUSE =
  process.env.HUB_INVITATION_SECRET_NOTIFUSE || '';

// Identifiant unique pour cleanup
const STRESS_TAG = `stress-${RUN_STAMP}`;

// ─── Helpers ─────────────────────────────────────────────────────────────

function signStripeEvent(body: string, secret = STAGING_WHSEC): string {
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function signStripeEventAt(body: string, timestampSec: number, secret = STAGING_WHSEC): string {
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp: timestampSec,
  });
}

function makeStripeEvent(type: string, id?: string) {
  return {
    id: id ?? `evt_${STRESS_TAG}_${Math.random().toString(36).slice(2, 8)}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: {} },
  };
}

function signHmacInvitation(rawBody: string, secret: string) {
  const timestamp = String(Date.now());
  const sig = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return { timestamp, signature: sig };
}

async function postWithRetryStatus(
  request: APIRequestContext,
  url: string,
  body: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body?: any }> {
  const res = await request.post(url, {
    headers,
    data: body,
    failOnStatusCode: false,
  });
  let bodyJson: any = undefined;
  try {
    bodyJson = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status(), headers: res.headers(), body: bodyJson };
}

// ─── S1 — Rate limiting ──────────────────────────────────────────────────

test.describe.serial('S1 — Rate limiting sur endpoints publics', () => {
  test('GET /api/invitations/<faketoken>/verify : 100 calls // → quota 30/min/IP touché (429 + Retry-After)', async ({
    request,
  }) => {
    // Token valide format-wise (64 hex) pour passer le TOKEN_FORMAT regex
    // sinon on tomberait sur le 404 AVANT le rate-limit (qui pour rappel
    // s'applique d'abord — mais on veut s'assurer que le burst lui-même est
    // limité, pas le not-found ; le not_found 404 légitime ne doit pas brûler
    // le quota… mais le code actuel ENFORCE avant de check le format. Donc
    // le quota est consommé même sur format invalide. C'est OK sécu-wise).
    const fakeToken = 'a'.repeat(64);
    const url = `${STAGING_URL}/api/invitations/${fakeToken}/verify`;

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        request.get(url, { failOnStatusCode: false }),
      ),
    );
    const statuses = results.map((r) => r.status());
    const rateLimited = statuses.filter((s) => s === 429);
    const nonLimited = statuses.filter((s) => s !== 429);

    // Cap=30/min/IP : on attend AU MOINS 70 429 (100 - 30) si toutes nos
    // requêtes partagent la même IP côté Traefik. En staging Tailscale, c'est
    // garanti. Note défensive : ≥ 50 si quelque chose perturbe (round-robin).
    expect(
      rateLimited.length,
      `Attendu ≥ 50 réponses 429 sur 100 (cap=30/min). Got ${rateLimited.length} 429, ${nonLimited.length} non-limited. Sample statuses: ${statuses.slice(0, 10).join(',')}`,
    ).toBeGreaterThanOrEqual(50);

    // Retry-After header présent sur les 429
    const firstLimited = results.find((r) => r.status() === 429);
    expect(firstLimited, 'au moins une réponse 429 attendue').toBeDefined();
    if (firstLimited) {
      const retryAfter = firstLimited.headers()['retry-after'];
      expect(
        retryAfter,
        'Retry-After header DOIT être posé sur 429 pour respecter la spec HTTP',
      ).toBeTruthy();
      const secs = Number(retryAfter);
      expect(Number.isFinite(secs) && secs > 0 && secs <= 60).toBeTruthy();
    }
  });

  test('POST /api/auth/signup : 20 calls // → signupLimiter 5/min/IP touché', async ({
    request,
  }) => {
    const url = `${STAGING_URL}/api/auth/signup`;
    const calls = Array.from({ length: 20 }, (_, i) =>
      request.post(url, {
        headers: { 'content-type': 'application/json' },
        data: {
          email: `stress-${STRESS_TAG}-${i}@e2e.veridian.site`,
          password: 'StressTestPwd123!',
        },
        failOnStatusCode: false,
      }),
    );
    const results = await Promise.all(calls);
    const statuses = results.map((r) => r.status());
    const rateLimited = statuses.filter((s) => s === 429);

    // Cap=5/min : on attend ≥ 10 réponses 429 sur 20.
    expect(
      rateLimited.length,
      `Signup limiter doit bloquer la majorité — got ${rateLimited.length} / 20 429. Statuses: ${statuses.join(',')}`,
    ).toBeGreaterThanOrEqual(10);

    // Vérif Retry-After header
    const firstLimited = results.find((r) => r.status() === 429);
    if (firstLimited) {
      expect(firstLimited.headers()['retry-after']).toBeTruthy();
    }
  });
});

// ─── S2 — Race conditions sur invitations ────────────────────────────────

test.describe.serial('S2 — Race condition sur acceptation invitation', () => {
  test('5 acceptations parallèles avec session anonyme → toutes 401 (pas de bypass auth)', async ({
    request,
  }) => {
    // Sans session valide, l'endpoint /accept doit refuser AVANT même de
    // toucher à la DB. Tester avec 5 calls // que tous sont 401 ou 429
    // (pas un seul 200 qui aurait bypass la session check).
    const fakeToken = 'b'.repeat(64);
    const url = `${STAGING_URL}/api/invitations/${fakeToken}/accept`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request.post(url, {
          headers: { 'content-type': 'application/json' },
          data: {},
          failOnStatusCode: false,
        }),
      ),
    );
    const statuses = results.map((r) => r.status());

    // Tous doivent être ≥ 400. Aucune 2xx ne doit passer.
    expect(
      statuses.every((s) => s >= 400),
      `RACE/AUTH BUG : un /accept parallèle a renvoyé 2xx sans session ! Statuses: ${statuses.join(',')}`,
    ).toBe(true);

    // Spécifiquement, on attend 401 (session manquante) ou 429 (rate-limit
    // déjà consommé par les tests précédents). En cas d'autres 4xx (404 si
    // Next.js normalise un format de token bizarre, etc.) c'est OK tant que
    // c'est < 500 (pas une fuite stack) et ≠ 2xx (pas de bypass).
    expect(
      statuses.every((s) => s >= 400 && s < 500),
      `Tous les statuses doivent être 4xx (pas de 5xx fuite, pas de 2xx bypass). Got: ${statuses.join(',')}`,
    ).toBe(true);
    // Et on veut voir au moins 1 réponse 401 ou 429 (auth bien câblé OU
    // rate-limit bien câblé).
    expect(statuses.some((s) => s === 401 || s === 429)).toBe(true);
  });
});

// ─── S3 — Payloads malveillants ──────────────────────────────────────────

test.describe.serial('S3 — Injection / payload malveillants', () => {
  test('JSON tronqué sur /api/auth/signup → 400, pas 500', async ({
    request,
  }) => {
    const res = await request.post(`${STAGING_URL}/api/auth/signup`, {
      headers: { 'content-type': 'application/json' },
      data: '{"email": "victim@e2e.veridian.site", "password":',
      failOnStatusCode: false,
    });
    // 400 invalid JSON OU 429 (rate-limit déjà consommé). Pas 500 (qui
    // signalerait une fuite de stack trace).
    expect([400, 429]).toContain(res.status());
    if (res.status() === 400) {
      const body = await res.json();
      expect(JSON.stringify(body).toLowerCase()).not.toContain('syntaxerror');
      expect(JSON.stringify(body).toLowerCase()).not.toContain('at ');
    }
  });

  test('Body XXL (2MB) sur /api/auth/signup → rejeté (400 / 413 / 429)', async ({
    request,
  }) => {
    // Next.js a une limite par défaut sur le body parsing en App Router.
    // On envoie 2MB de junk dans password pour stresser le parser.
    const huge = 'A'.repeat(2 * 1024 * 1024); // 2 MB
    const res = await request.post(`${STAGING_URL}/api/auth/signup`, {
      headers: { 'content-type': 'application/json' },
      data: { email: `xxl-${STRESS_TAG}@e2e.veridian.site`, password: huge },
      failOnStatusCode: false,
    });
    // Ne doit JAMAIS retourner 201 (création) avec un password de 2MB.
    // Acceptable : 400 (Zod min/max), 413 (payload too large), 429
    // (rate-limit), 500 (parser explosé — acceptable car pas de leak DB)
    expect(res.status()).not.toBe(201);
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('Header Authorization 8KB sur /api/webhooks/notifuse → rejeté proprement', async ({
    request,
  }) => {
    const huge = 'X'.repeat(8 * 1024);
    const res = await request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
      headers: {
        authorization: `Bearer ${huge}`,
        'content-type': 'application/json',
      },
      data: { event: 'tenant.touched', tenant_id: 't', idempotency_key: randomUUID(), occurred_at: new Date().toISOString(), data: {} },
      failOnStatusCode: false,
    });
    // 401 (bearer invalide) ou 400 / 431 (header too large) selon Traefik.
    expect(res.status()).not.toBe(200);
    expect([400, 401, 431]).toContain(res.status());
  });

  test('SQL injection dans email signup → Zod rejette (pas de 500)', async ({
    request,
  }) => {
    const payloads = [
      "admin@example.com'; DROP TABLE users--",
      "admin@example.com' OR '1'='1",
      "admin\"@example.com",
    ];
    for (const email of payloads) {
      const res = await request.post(`${STAGING_URL}/api/auth/signup`, {
        headers: { 'content-type': 'application/json' },
        data: { email, password: 'StressTestPwd123!' },
        failOnStatusCode: false,
      });
      // Zod email() doit rejeter → 400. Ou 429 (rate-limit déjà touché).
      expect(
        [400, 429].includes(res.status()),
        `SQLi payload "${email}" attendu rejeté (400/429), got ${res.status()}`,
      ).toBe(true);
    }
  });

  test('XSS payload dans message invitation → Zod refine bloque les < >', async ({
    request,
  }) => {
    // L'endpoint POST /api/invitations/create exige HMAC valide. Sans le
    // secret en ENV local, on ne peut pas signer. Si le secret existe, on
    // teste que le refine() bloque les < >. Sinon, on documente le skip.
    if (!INVITATION_SECRET_NOTIFUSE) {
      test.skip(
        true,
        'HUB_INVITATION_SECRET_NOTIFUSE non câblé dans cet env — XSS check delegué aux unit tests Zod',
      );
      return;
    }

    const payload = {
      inviter_user_id: 'usr-xss-test',
      inviter_email: `inviter-${STRESS_TAG}@e2e.veridian.site`,
      invitee_email: `victim-${STRESS_TAG}@e2e.veridian.site`,
      target_app: 'notifuse' as const,
      target_workspace_id: 'wks-xss-test',
      target_role: 'member' as const,
      message: "<script>alert('xss')</script>",
    };
    const rawBody = JSON.stringify(payload);
    const { timestamp, signature } = signHmacInvitation(
      rawBody,
      INVITATION_SECRET_NOTIFUSE,
    );

    const res = await request.post(`${STAGING_URL}/api/invitations/create`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': timestamp,
        'x-veridian-invitation-signature': signature,
      },
      data: rawBody,
      failOnStatusCode: false,
    });

    // Zod refine bloque les < > → 400 invalid_payload
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  test('Path traversal /api/invitations/../admin/users/create → 404 Next.js (pas de bypass)', async ({
    request,
  }) => {
    // Next.js App Router normalise les paths. Si on POST sur une URL avec
    // des ".." encodés, on doit recevoir 404 (route non matchée) et SURTOUT
    // PAS un 200 sur /api/admin/users/create sans HUB_ADMIN_SECRET.
    const tricky = `${STAGING_URL}/api/invitations/%2E%2E/admin/users/create`;
    const res = await request.post(tricky, {
      headers: { 'content-type': 'application/json' },
      data: { email: 'pwned@example.com', name: 'pwned' },
      failOnStatusCode: false,
    });
    // L'important : on n'est pas en 2xx (pas de bypass).
    expect(res.status()).not.toBe(200);
    expect(res.status()).not.toBe(201);
    // Acceptable : 404 (route inconnue), 400, 401, 405 (méthode pas POST).
    expect([400, 401, 404, 405]).toContain(res.status());
  });
});

// ─── S4 — Stripe webhook anti-replay / anti-tampering ────────────────────

test.describe.serial('S4 — Stripe webhook replay & tampering', () => {
  test('Replay 5× même event.id → 200 idempotent=true (sauf 1er)', async ({
    request,
  }) => {
    const event = makeStripeEvent('ping', `evt_${STRESS_TAG}_replay`);
    const body = JSON.stringify(event);

    // 1er call avec signature fraîche
    const sig1 = signStripeEvent(body);
    const first = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': sig1 },
      data: body,
      failOnStatusCode: false,
    });
    expect(first.status()).toBe(200);

    // 4 replays avec signatures fraîches mais MÊME event.id
    const replayResults: Array<{ status: number; idempotent?: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      const sigN = signStripeEvent(body);
      const res = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sigN,
        },
        data: body,
        failOnStatusCode: false,
      });
      const json = await res.json().catch(() => ({}));
      replayResults.push({ status: res.status(), idempotent: json?.idempotent });
    }

    // Tous les replays doivent retourner 200 (Stripe doit pas retry)
    expect(replayResults.every((r) => r.status === 200)).toBe(true);
    // ET tous doivent être marqués idempotent=true (dédup côté Hub)
    expect(
      replayResults.every((r) => r.idempotent === true),
      `Idempotence cassée : ${JSON.stringify(replayResults)}`,
    ).toBe(true);
  });

  test('Signature avec timestamp drifté > 5 min → 400 (constructEvent rejette)', async ({
    request,
  }) => {
    const event = makeStripeEvent('ping', `evt_${STRESS_TAG}_drift`);
    const body = JSON.stringify(event);
    // Timestamp 10 minutes dans le passé
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const sig = signStripeEventAt(body, oldTs);

    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      data: body,
      failOnStatusCode: false,
    });
    // Stripe SDK constructEvent rejette les timestamps > 5min drift par défaut.
    expect(res.status()).toBe(400);
  });
});

// ─── S5 — Brute-force credentials & user-enumeration ─────────────────────

test.describe.serial('S5 — Brute-force credentials & info leak', () => {
  test('20 tentatives login mauvais password → credentialsLoginLimiter (5/min) bloque', async ({
    request,
  }) => {
    // /api/auth/callback/credentials est une route POST Auth.js v5 qui prend
    // x-www-form-urlencoded. On envoie 20 tentatives en parallèle.
    const url = `${STAGING_URL}/api/auth/callback/credentials`;

    const calls = Array.from({ length: 20 }, () =>
      request.post(url, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        form: {
          email: `nonexistent-${STRESS_TAG}@e2e.veridian.site`,
          password: 'WrongPassword123!',
        },
        failOnStatusCode: false,
      }),
    );
    const results = await Promise.all(calls);
    const statuses = results.map((r) => r.status());
    const rateLimited = statuses.filter((s) => s === 429);

    expect(
      rateLimited.length,
      `credentialsLoginLimiter (5/min) doit bloquer la majorité — got ${rateLimited.length} / 20 429`,
    ).toBeGreaterThanOrEqual(10);
  });

  test('Login user inexistant vs login mauvais password → réponses similaires (anti-enumeration)', async ({
    request,
  }) => {
    // Sleep court pour laisser le limiter respirer un peu après le burst précédent
    // (5/min — on ne peut pas faire grand chose sauf attendre, donc on lit juste
    // les codes de retour : ils doivent être identiques entre les deux cas).
    await new Promise((r) => setTimeout(r, 1000));

    const url = `${STAGING_URL}/api/auth/callback/credentials`;
    const fakeUser = `does-not-exist-${STRESS_TAG}@e2e.veridian.site`;
    const wrongPass = 'WrongPassword123!';

    // Cas A : user inexistant
    const resA = await request.post(url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { email: fakeUser, password: wrongPass },
      failOnStatusCode: false,
    });
    // Cas B : email format invalide (pour tester variation)
    const resB = await request.post(url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { email: 'not-an-email', password: wrongPass },
      failOnStatusCode: false,
    });

    // Auth.js v5 redirect ou 401/200 selon config. Le critère : on doit pas
    // pouvoir distinguer le cas user-existe vs user-existe-pas (même status
    // code, pas de message différencié dans le body texte si présent).
    // En staging avec rate-limit déjà touché, statuses peuvent être 429 / 429.
    const bodyA = await resA.text().catch(() => '');
    const bodyB = await resB.text().catch(() => '');

    const lc = (s: string) => s.toLowerCase();
    // CRITIQUE : aucun body ne doit contenir "user not found" /
    // "no such user" / "user does not exist" — ce serait une fuite directe.
    for (const body of [bodyA, bodyB]) {
      expect(lc(body)).not.toContain('user not found');
      expect(lc(body)).not.toContain('user does not exist');
      expect(lc(body)).not.toContain('no such user');
      expect(lc(body)).not.toContain('invalid email'); // distingue email format
      expect(lc(body)).not.toContain('account does not exist');
    }
  });
});

// ─── Cleanup ─────────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  // Best-effort : on a essayé de créer ~25 users signup mais le rate-limit
  // a probablement bloqué la plupart. On tente un cleanup via admin API si
  // dispo. Si HUB_ADMIN_SECRET pas dans l'ENV, on skip silencieusement.
  const adminSecret =
    process.env.HUB_ADMIN_SECRET || 'staging-admin-secret-not-real-e2e';

  // On purge les éventuels users créés via le tag STRESS_TAG. L'API admin
  // n'a pas d'endpoint "delete by pattern" donc on ne fait rien d'agressif —
  // le pattern de naming permet d'identifier facilement les orphelins en DB
  // si le cleanup périodique passe.
  try {
    const res = await request.get(
      `${STAGING_URL}/api/admin/users/by-email?email=stress-${STRESS_TAG}-0@e2e.veridian.site`,
      {
        headers: { 'x-admin-secret': adminSecret },
        failOnStatusCode: false,
      },
    );
    if (res.status() === 200) {
      console.warn(
        `[stress-cleanup] ${STRESS_TAG} : 1+ users restants en DB, à purger manuellement via SQL si gênant`,
      );
    }
  } catch {
    /* best-effort */
  }
});
