/**
 * MEGA I-03 — SSRF (Server-Side Request Forgery) sur surfaces URL externes
 *
 * **CIBLES** : endpoints qui acceptent une URL externe dans le body.
 *   1. `POST /api/admin/tenants/link-app` — champ `fallback_url`
 *      (déjà whitelist http(s) via Zod refine, à vérifier en bout-en-bout)
 *   2. `POST /api/billing/refill-leads/checkout-from-app` — `success_url` /
 *      `cancel_url` (HMAC-authentifié, mais on tente quand même)
 *   3. `POST /api/auth/callback/mock-oauth` — `callbackUrl`
 *      (Auth.js v5 normalise mais on vérifie le comportement)
 *
 * **PAYLOADS SSRF CLASSIQUES** :
 *   - `http://169.254.169.254/` — AWS/GCP metadata
 *   - `http://[::1]:80/` — IPv6 loopback (souvent oublié)
 *   - `http://localhost:5432/` — Postgres local
 *   - `http://127.0.0.1:6379/` — Redis local
 *   - `http://hub-staging-db:5432/` — Container voisin sur le réseau Docker
 *   - `file:///etc/passwd` — File scheme
 *   - `gopher://...` — Old protocol pour bypass
 *   - `javascript:alert(1)` — XSS si rendu côté client
 *   - `data:text/html,<script>` — Data URI XSS
 *
 * **CRITÈRES HARDCORE** :
 *   - Pour `fallback_url` Zod doit rejeter avec 400 sur tous payloads non-http(s)
 *   - Pour les success_url/cancel_url Stripe : on accepte HTTPS uniquement
 *     OU on défère à Stripe Checkout (qui rejette les domaines non-whitelistés)
 *   - JAMAIS de 200 sur scheme dangereux (file:, javascript:, gopher:, data:)
 *   - JAMAIS de 5xx (qui prouverait que le payload est passé jusqu'à un fetch)
 *
 * **NOTE LIMITATION** : on ne peut pas vérifier que le Hub n'a pas FAIT le
 * fetch SSRF (pas de canary endpoint). On vérifie seulement que la validation
 * en amont (Zod refine) rejette → la requête sortante n'a jamais lieu.
 *
 * **MARKER** : `[risk:medium]` — défense critique réseau.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

const ADMIN_SECRET =
  process.env.HUB_ADMIN_SECRET || 'staging-admin-secret-not-real-e2e';

const BUCKET = 'i';
const SPEC = '03-ssrf';

function tag(suffix: string): string {
  return `e2e-mega-${BUCKET}-${SPEC}-${suffix}-${MEGA_RUN_STAMP}`;
}

// Payloads SSRF/scheme-injection classiques.
// On teste qu'AUCUN ne passe la validation côté Zod (link-app).
const DANGEROUS_URLS = [
  // SSRF cloud metadata
  'http://169.254.169.254/',
  'http://169.254.169.254/latest/meta-data/',
  // Loopback
  'http://localhost:5432/',
  'http://127.0.0.1:6379/',
  'http://127.0.0.1:11211/',
  // IPv6 loopback (souvent oublié dans les blocklists)
  'http://[::1]/',
  // Container voisin (pivot interne réseau Docker staging)
  'http://hub-staging-db:5432/',
  'http://notifuse-staging-db:5432/',
  // Scheme dangereux
  'file:///etc/passwd',
  'file:///etc/shadow',
  'javascript:alert(document.cookie)',
  'data:text/html,<script>alert(1)</script>',
  'gopher://localhost:6379/_FLUSHALL',
  // FTP (rare mais possible bypass)
  'ftp://localhost/',
  // Mauvais format (vide, espaces)
  '',
  '   ',
  // Tentative URL relative pour bypass scheme check
  '//169.254.169.254/',
  '\\\\169.254.169.254\\share',
];

// Helper : crée un user Hub puis tente le link-app avec un fallback_url malicieux.
async function setupUserForLinkApp(
  request: APIRequestContext,
  email: string,
): Promise<boolean> {
  const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
    headers: {
      'content-type': 'application/json',
      'x-admin-secret': ADMIN_SECRET,
    },
    data: { email, name: 'SSRF Setup' },
    failOnStatusCode: false,
  });
  return res.status() === 200;
}

test.describe.configure({ mode: 'serial' });

test.describe('Mega I-03 — SSRF sur POST /api/admin/tenants/link-app fallback_url', () => {
  test('crée un user de setup pour le test de link-app', async ({ request }) => {
    const email = `${tag('setup')}@e2e.veridian.site`;
    const ok = await setupUserForLinkApp(request, email);
    expect(
      ok,
      'setup user create doit réussir (sinon admin secret manquant en env)',
    ).toBe(true);
  });

  for (const url of DANGEROUS_URLS) {
    test(`fallback_url = "${url.slice(0, 60)}" → REJETÉ (400/422), JAMAIS 200`, async ({
      request,
    }) => {
      const email = `${tag(`ssrf-${url.length}-${Math.abs(hashStr(url))}`)}@e2e.veridian.site`;
      // Recréer le user au cas où il a été purge entre tests
      await setupUserForLinkApp(request, email);

      const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP.slice(-8)}-${Math.abs(hashStr(url)) % 10000}`;
      const r = await request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': ADMIN_SECRET,
        },
        data: {
          user_email: email,
          app: 'cms',
          external_tenant_id: '1',
          external_tenant_slug: slug,
          tenant_name: 'SSRF test',
          fallback_url: url,
        },
        failOnStatusCode: false,
      });
      // CRITIQUE : JAMAIS 200 sur scheme dangereux ou format invalide.
      expect(
        r.status(),
        `SSRF/scheme attack "${url}" doit être rejeté, got ${r.status()}`,
      ).not.toBe(200);
      // 400 ou 422 attendu (Zod url() rejette le format ou refine() rejette le scheme)
      // 429 si rate-limit consommé
      expect([400, 401, 422, 429]).toContain(r.status());
      // Pas de 5xx (sinon Zod n'a pas catch → payload passé plus loin)
      expect(r.status(), `payload "${url}" ne doit jamais provoquer 5xx`).toBeLessThan(500);
    });
  }
});

test.describe('Mega I-03 — SSRF sur POST /api/billing/refill-leads/checkout-from-app success_url', () => {
  // Cet endpoint exige HMAC valide. Sans le secret, on s'attend à 400/401 sur
  // l'auth — mais on teste quand même : si l'auth retournait 400 pour signature
  // ET aussi 400 pour bad url, on est OK ; si une path-trompe retournait 200
  // ou 5xx, c'est qu'un payload SSRF passe.

  const PROSPECTION_HUB_SECRET =
    process.env.PROSPECTION_HUB_API_SECRET || '';

  for (const url of ['file:///etc/passwd', 'javascript:void(0)', 'gopher://localhost/', 'http://169.254.169.254/']) {
    test(`success_url = "${url.slice(0, 40)}" → REJETÉ par Zod url() OU par HMAC, JAMAIS 200`, async ({
      request,
    }) => {
      const body = JSON.stringify({
        tenant_id: `mega-ssrf-${MEGA_RUN_STAMP}-${Math.abs(hashStr(url)) % 1000}`,
        quantity: 100,
        plan: 'pro',
        success_url: url,
        cancel_url: 'https://example.com/cancel',
        contract_version: '2.1',
      });

      // On envoie sans HMAC valide volontairement (test SSRF, pas test HMAC).
      // L'endpoint doit rejeter SOIT sur HMAC (400/401) SOIT sur Zod url() (400).
      // Critère : jamais 200, jamais 5xx.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-veridian-app': 'prospection',
        'x-veridian-timestamp': String(Date.now()),
      };
      if (PROSPECTION_HUB_SECRET) {
        // Si on a le secret, on peut tester que la validation Zod kick AVANT
        // que le checkout Stripe soit appelé. Mais l'endpoint refuse aussi via
        // wrong-HMAC, ce qui suffit pour notre critère SSRF.
        const { createHmac } = await import('node:crypto');
        const timestamp = headers['x-veridian-timestamp'];
        const sig = createHmac('sha256', PROSPECTION_HUB_SECRET)
          .update(`${timestamp}.${body}`)
          .digest('hex');
        headers['x-veridian-billing-signature'] = sig;
      } else {
        headers['x-veridian-billing-signature'] = 'a'.repeat(64);
      }

      const r = await request.post(
        `${STAGING_URL}/api/billing/refill-leads/checkout-from-app`,
        { headers, data: body, failOnStatusCode: false },
      );

      expect(
        r.status(),
        `SSRF "${url}" ne doit JAMAIS retourner 200`,
      ).not.toBe(200);
      expect(
        r.status(),
        `SSRF "${url}" ne doit JAMAIS retourner 5xx (parser explosé). Got ${r.status()}`,
      ).toBeLessThan(500);
    });
  }
});

test.describe('Mega I-03 — Callback URL sanitization (mock-oauth)', () => {
  test('callbackUrl = "javascript:alert(1)" → Auth.js sanitize (pas de redirect malicieux)', async ({
    request,
  }) => {
    // Auth.js v5 par défaut normalise les callbackUrl et rejette les schemes
    // dangereux. On teste que le mock-oauth respecte ce contrat.
    const csrf = await request
      .get(`${STAGING_URL}/api/auth/csrf`)
      .then((r) => r.json());

    const res = await request.post(
      `${STAGING_URL}/api/auth/callback/mock-oauth`,
      {
        form: {
          csrfToken: csrf.csrfToken,
          email: `${tag('cburl')}@e2e.veridian.site`,
          mockProvider: 'google',
          mockEmailVerified: 'true',
          callbackUrl: 'javascript:alert(document.cookie)',
          json: 'true',
        },
        maxRedirects: 0,
        failOnStatusCode: false,
      },
    );

    // L'endpoint peut accepter la requête (création user) mais le `redirect`
    // retourné doit JAMAIS être javascript:. Auth.js v5 normalise vers le
    // baseUrl. On vérifie le body / Location header.
    if (res.status() === 302 || res.status() === 303) {
      const loc = res.headers()['location'] || '';
      expect(
        loc.toLowerCase(),
        `Location header ne doit JAMAIS contenir un scheme javascript:`,
      ).not.toContain('javascript:');
    }
    let bodyJson: any = null;
    try {
      bodyJson = await res.json();
    } catch {
      /* not JSON */
    }
    if (bodyJson?.url) {
      expect(String(bodyJson.url).toLowerCase()).not.toContain('javascript:');
      expect(String(bodyJson.url).toLowerCase()).not.toContain('data:');
    }
  });

  test('callbackUrl = "http://attacker.example.com/" (off-origin) → Auth.js normalise au baseUrl', async ({
    request,
  }) => {
    const csrf = await request
      .get(`${STAGING_URL}/api/auth/csrf`)
      .then((r) => r.json());

    const res = await request.post(
      `${STAGING_URL}/api/auth/callback/mock-oauth`,
      {
        form: {
          csrfToken: csrf.csrfToken,
          email: `${tag('offorig')}@e2e.veridian.site`,
          mockProvider: 'google',
          mockEmailVerified: 'true',
          callbackUrl: 'http://attacker.example.com/pwn',
          json: 'true',
        },
        maxRedirects: 0,
        failOnStatusCode: false,
      },
    );

    // Auth.js v5 doit normaliser une URL hors origine vers le baseUrl.
    // Le redirect (s'il existe) NE doit PAS pointer sur attacker.example.com.
    if (res.status() === 302 || res.status() === 303) {
      const loc = res.headers()['location'] || '';
      expect(
        loc.toLowerCase(),
        `Auth.js v5 doit refuser un callbackUrl off-origin. Location: ${loc}`,
      ).not.toContain('attacker.example.com');
    }
    let bodyJson: any = null;
    try {
      bodyJson = await res.json();
    } catch {
      /* not JSON */
    }
    if (bodyJson?.url) {
      expect(
        String(bodyJson.url).toLowerCase(),
        `body.url ne doit pas pointer hors origine`,
      ).not.toContain('attacker.example.com');
    }
  });
});

// Hash naïf pour générer des slugs uniques par payload (déterministe par run).
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
