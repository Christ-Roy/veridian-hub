/**
 * Journey 12bis — Stripe TEST account config invariants.
 *
 * **POURQUOI** : le 2026-05-23, un vrai bug Stripe staging (`head_office:
 * null` côté preprod → automatic_tax rejetait chaque session avec
 * `stripe_session_failed`) **n'a pas été détecté** par la suite E2E
 * pendant ~6h car le spec 12 S7 tolérait `[200, 502, 503]`. Bug trouvé
 * manuellement via Stripe Tax API + fix posé via `POST /v1/tax/settings`
 * head_office.
 *
 * Cette spec **anti-régression** asserte directement la config compte
 * Stripe TEST via l'API officielle Stripe (pas via le Hub). Si une
 * régression remet `head_office: null` (rotation compte, reset env,
 * mauvaise clé sourcée), ce test pète immédiatement au lieu de masquer
 * le bug derrière un fallback 503 dans le checkout flow.
 *
 * **CE QUE CE SPEC COUVRE** :
 *   S1 GET /v1/tax/settings → `status === 'active'`
 *   S2 head_office.address.country === 'FR'
 *   S3 head_office.address.postal_code non-vide
 *
 * **DÉPENDANCES** :
 *   - `STRIPE_SECRET_KEY_TEST` exporté (auto-sourcé par
 *     `scripts/e2e/staging-full.sh` depuis `~/credentials/.all-creds.env`)
 *   - Compte Stripe TEST avec Tax activé + head_office FR configuré
 *
 * **SI ABSENT** :
 *   - Pas de clé → tests skipped (warning explicite, pas de fail)
 *   - Clé présente mais Tax inactive → fail explicite avec runbook
 */
import { test, expect } from '@playwright/test';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY_TEST || '';
const HAS_KEY = STRIPE_SECRET.startsWith('sk_test_');

interface StripeAddress {
  country?: string | null;
  postal_code?: string | null;
  city?: string | null;
  line1?: string | null;
}

interface StripeHeadOffice {
  address?: StripeAddress | null;
}

interface StripeTaxSettings {
  status?: 'active' | 'pending' | string;
  head_office?: StripeHeadOffice | null;
  defaults?: {
    tax_code?: string | null;
    tax_behavior?: string | null;
  } | null;
}

async function fetchTaxSettings(): Promise<StripeTaxSettings> {
  // Stripe API : GET https://api.stripe.com/v1/tax/settings
  // Doc : https://stripe.com/docs/api/tax/settings
  const res = await fetch('https://api.stripe.com/v1/tax/settings', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET}`,
      'Stripe-Version': '2024-06-20',
    },
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `[12bis] GET /v1/tax/settings failed: ${res.status} ${bodyText.slice(0, 400)}`,
    );
  }
  return JSON.parse(bodyText) as StripeTaxSettings;
}

test.describe('Journey 12bis — Stripe TEST account config (anti-régression head_office)', () => {
  test.skip(
    !HAS_KEY,
    'STRIPE_SECRET_KEY_TEST manquant — exporter via scripts/e2e/staging-full.sh ou ~/credentials/.all-creds.env',
  );

  test('S1 : Stripe Tax settings.status === "active" (sinon automatic_tax KO en checkout)', async () => {
    const settings = await fetchTaxSettings();
    expect(
      settings.status,
      `Stripe Tax doit être ACTIVE sur le compte TEST, sinon ` +
        `automatic_tax: { enabled: true } côté Checkout rejette chaque session. ` +
        `Runbook : dashboard.stripe.com/test/tax/settings → Activate. ` +
        `Réponse Stripe : ${JSON.stringify(settings).slice(0, 400)}`,
    ).toBe('active');
  });

  test('S2 : head_office.address.country === "FR" (sinon automatic_tax rejette)', async () => {
    const settings = await fetchTaxSettings();
    expect(
      settings.head_office,
      `head_office DOIT être présent (pas null). C'est exactement le bug ` +
        `du 2026-05-23 qui a masqué un checkout pété pendant 6h. ` +
        `Runbook : POST /v1/tax/settings -d "head_office[address][country]=FR" ` +
        `(cf. ticket e2e-harden-tolerances + Stripe docs Tax origin). ` +
        `Réponse Stripe : ${JSON.stringify(settings).slice(0, 400)}`,
    ).not.toBeNull();
    expect(settings.head_office).toBeDefined();

    const address = settings.head_office?.address;
    expect(
      address,
      'head_office.address DOIT être présent (sinon automatic_tax rejette en checkout)',
    ).toBeDefined();
    expect(address).not.toBeNull();

    expect(
      address?.country,
      `head_office.address.country DOIT être 'FR'. Veridian opère ` +
        `depuis la France, c'est l'origine fiscale. Si autre pays = ` +
        `migration fiscale non-déclarée. Got: ${JSON.stringify(address)}`,
    ).toBe('FR');
  });

  test('S3 : head_office.address.postal_code non-vide (exigé par automatic_tax FR)', async () => {
    const settings = await fetchTaxSettings();
    const postalCode = settings.head_office?.address?.postal_code;
    expect(
      typeof postalCode,
      `head_office.address.postal_code DOIT être une string non-vide. ` +
        `Stripe automatic_tax FR exige un code postal pour résoudre les ` +
        `règles de TVA. Got: ${JSON.stringify(settings.head_office?.address)}`,
    ).toBe('string');
    expect(postalCode, 'postal_code non-vide').not.toBe('');
    // FR : 5 chiffres (mais on n'asserte que le pattern minimum pour
    // éviter de bloquer sur des codes DOM-TOM ou cas exotiques).
    expect(postalCode).toMatch(/^\d{4,5}$/);
  });
});
