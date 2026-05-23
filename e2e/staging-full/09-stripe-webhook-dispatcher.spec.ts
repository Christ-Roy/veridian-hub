/**
 * Journey 9 — Stripe webhook dispatcher central (POST /api/webhooks).
 *
 * **CONTEXTE** : refactor 2026-05-21 (ticket stripe-webhook-orchestrator)
 * a fait du Hub l'orchestrateur central qui :
 *   1. Valide la signature Stripe (whsec)
 *   2. Persiste l'event dans `hub_app.stripe_events` (PK = event.id) → idempotence
 *   3. Dispatch vers les apps downstream en HMAC pour subscription.* /
 *      invoice.* / customer.deleted
 *   4. Alerte Telegram Robert sur fail dispatch
 *
 * **STAGING SPECIFIC** : depuis 2026-05-23, le compose staging utilise la
 * vraie valeur Stripe TEST `${STRIPE_WEBHOOK_SECRET_TEST:-whsec_fake}`.
 * Les fixtures résolvent dynamiquement le secret (env > fallback) — cf.
 * `STAGING_WHSEC` plus bas. Le runner `scripts/e2e/staging-full.sh`
 * exporte automatiquement la clé depuis `~/credentials/.all-creds.env`.
 *
 * **CE SPEC COUVRE** :
 *   1. Signature invalide → 400
 *   2. Signature absente → 400
 *   3. Event valide non-mappé (type 'ping') → 200 outcome=ignored
 *   4. Idempotence : replay même event.id → 200 idempotent=true
 *   5. Event type subscription.created (mock minimal) → 200 outcome ∈
 *      {processed, failed} (dispatch best-effort + alerte Telegram si fail —
 *      pas un fail dur Hub)
 *
 * **CE QUI N'EST PAS COUVERT** :
 *   - Le contenu des HMAC envoyés à Notifuse/Prospection (validé par les
 *     unit tests dispatcher) — on attaque seulement la surface Stripe → Hub.
 *
 * **MAINTENANCE** : si Stripe rotate son SDK ou si on change de version
 * d'API, mettre à jour `apiVersion` ci-dessous pour matcher le SDK installé.
 */
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

const STAGING_URL = process.env.STAGING_URL || 'https://hub.staging.veridian.site';
// Le secret webhook côté staging suit cette priorité :
//   1. STRIPE_WEBHOOK_SECRET_TEST si exporté par le runner (valeur réelle Stripe
//      TEST persistée dans /opt/staging/hub/.env depuis 2026-05-23).
//   2. Fallback `whsec_fake` pour les setups historiques où le compose staging
//      utilise encore la valeur de défaut (cas dev local sans .env injecté).
// Cf. compose/staging.yml : `STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET_TEST:-whsec_fake}`.
const STAGING_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake';

// On utilise sk_test_fake comme clé fake. generateTestHeaderString n'appelle
// pas l'API Stripe — juste un HMAC local sur le payload.
const stripe = new Stripe('sk_test_fake');

function signEvent(body: string, secret = STAGING_WHSEC): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp,
  });
}

function makeMinimalEvent(
  type: string,
  override: Partial<Stripe.Event> = {},
): Stripe.Event {
  return {
    id: override.id ?? `evt_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: type as Stripe.Event.Type,
    data: {
      object: override.data?.object ?? ({} as Stripe.Event.Data['object']),
    } as Stripe.Event.Data,
    ...override,
  } as Stripe.Event;
}

// ─── Signature validation ────────────────────────────────────────────────

test.describe('Journey 9 — Stripe webhook signature', () => {
  test('signature absente → 400', async ({ request }) => {
    const event = makeMinimalEvent('ping');
    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(event),
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test('signature bidon → 400', async ({ request }) => {
    const event = makeMinimalEvent('ping');
    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature':
          't=1234567890,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
      data: JSON.stringify(event),
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test('payload modifié après signing → 400', async ({ request }) => {
    const event = makeMinimalEvent('ping');
    const body = JSON.stringify(event);
    const signature = signEvent(body);

    // On envoie un body DIFFÉRENT de celui qu'on a signé → invalide.
    const tamperedBody = body.replace('ping', 'attack');
    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      data: tamperedBody,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });
});

// ─── Happy path + idempotence ────────────────────────────────────────────

test.describe('Journey 9 — Happy path + idempotence', () => {
  test('event non-mappé (type=ping) → 200 outcome=ignored', async ({
    request,
  }) => {
    const event = makeMinimalEvent('ping');
    const body = JSON.stringify(event);
    const signature = signEvent(body);

    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      data: body,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    // Outcome 'ignored' = event reconnu mais aucun handler ne le traite.
    // C'est le contrat documenté dispatcher.
    expect(['ignored', 'processed']).toContain(json.outcome);
  });

  test('idempotence : replay même event.id → idempotent=true sans re-dispatch', async ({
    request,
  }) => {
    const event = makeMinimalEvent('ping');
    const body = JSON.stringify(event);
    const signature = signEvent(body);

    const first = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      data: body,
      failOnStatusCode: false,
    });
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.idempotent).not.toBe(true);

    // Replay avec une signature fraiche (sinon stripe rejette timestamp old)
    // mais le MÊME body (donc même event.id). Le dispatcher voit la PK déjà
    // présente dans stripe_events et renvoie idempotent.
    const signature2 = signEvent(body);
    const second = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature2,
      },
      data: body,
      failOnStatusCode: false,
    });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(
      secondBody.idempotent,
      'replay même event.id DOIT renvoyer idempotent=true',
    ).toBe(true);
  });

  test('event subscription.created (data minimal) → 200 (outcome processed/failed/ignored)', async ({
    request,
  }) => {
    // On envoie un body minimal qui passe la signature mais qui peut
    // échouer côté handler business (customer pas en DB, etc.). Le contrat
    // dispatcher dit : Hub renvoie TOUJOURS 200 hors signature invalide.
    // Le dispatch échoue → marqué dans stripe_events.error → alerte Telegram.
    const event = makeMinimalEvent('customer.subscription.created', {
      data: {
        object: {
          id: 'sub_e2e_test',
          object: 'subscription',
          customer: 'cus_e2e_test',
          status: 'active',
          items: { data: [], has_more: false, object: 'list', url: '' },
          metadata: {},
          // Les autres champs requis par Stripe.Subscription peuvent manquer
          // — handler robust doit gérer.
        } as unknown as Stripe.Event.Data['object'],
      } as Stripe.Event.Data,
    });
    const body = JSON.stringify(event);
    const signature = signEvent(body);

    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      data: body,
      failOnStatusCode: false,
    });
    // INVARIANT critique : Hub doit TOUJOURS 200 sur signature valide,
    // même si dispatch échoue (sinon Stripe retry 50 fois pendant 3 jours).
    expect(
      res.status(),
      'CRITIQUE : signature valide → toujours 200, jamais 5xx',
    ).toBe(200);
    const json = await res.json();
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);
  });
});
