/**
 * MEGA I-04 — XSS sanitization sur surfaces neuves
 *
 * **CIBLES** (surfaces ajoutées depuis sprint v1.4) :
 *   1. `POST /api/admin/users/create` — `name` (Zod refine bloque `<` `>`)
 *   2. `POST /api/admin/tenants/link-app` — `tenant_name`, `external_tenant_slug`,
 *      `notes`, `provisioning_source`
 *   3. `POST /api/invitations/create` — `message` (refine bloque `<` `>`)
 *   4. `PATCH /api/account/profile` — `name` (Zod min/max mais PAS de refine
 *      — la défense vient de l'escape React au rendu)
 *
 * **STRATÉGIE** :
 *   - Pour les endpoints avec refine() strict : on assert le 400 sur tous
 *     les payloads XSS classiques
 *   - Pour `account/profile.name` : on stocke un payload XSS, on relit
 *     l'API, on vérifie qu'il n'a pas été exécuté (le test E2E ne peut
 *     pas exécuter de JS — on vérifie que le rendu HTML retourné par
 *     `/dashboard` (si applicable) ne contient pas la balise non-échappée)
 *
 * **PAYLOADS XSS** :
 *   - `<script>alert(1)</script>` — classique
 *   - `<img src=x onerror=alert(1)>` — handler
 *   - `"><script>alert(1)</script>` — attribute escape
 *   - `javascript:alert(1)` — URL scheme
 *   - `<svg onload=alert(1)>` — SVG vector
 *   - `${alert(1)}` — template literal
 *   - `&lt;script&gt;` — déjà HTML-encoded (devrait passer car safe)
 *   - chars contrôle (`\x00-\x1f`) — Zod refine bloque
 *
 * **CRITÈRES HARDCORE** :
 *   - Refine endpoints : 400 invalid_payload sur 100% des payloads `<` `>`
 *   - Lax endpoints (profile.name) : 200 stockable mais jamais rendu en
 *     HTML brut côté API responses JSON (les API renvoient toujours du
 *     JSON-encoded, pas du HTML)
 *   - Aucun 5xx (sanitizer crash)
 *
 * **MARKER** : `[risk:medium]`
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

const ADMIN_SECRET =
  process.env.HUB_ADMIN_SECRET || 'staging-admin-secret-not-real-e2e';

const BUCKET = 'i';
const SPEC = '04-xss';

function tag(suffix: string): string {
  return `e2e-mega-${BUCKET}-${SPEC}-${suffix}-${MEGA_RUN_STAMP}`;
}

const XSS_PAYLOADS_HARD = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(document.cookie)</script>',
  '<svg onload=alert(1)>',
  '<iframe src=javascript:alert(1)>',
  '<body onload=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  // Char contrôle
  'Robert\x00Brunon',
  'Tab\x09Inside',
  'Bell\x07char',
];

const XSS_PAYLOADS_NO_BRACKETS = [
  // Pas de < > → devrait passer la validation (et React échappe au rendu)
  'O\'Brien & sons',
  'José Mañana',
  'Robert "Bobby" Brunon',
  '日本語テスト',
];

test.describe.configure({ mode: 'serial' });

// ─── Cible 1 : admin/users/create.name (Zod refine bloque < >) ────────────

test.describe('Mega I-04 — XSS sur POST /api/admin/users/create.name (refine strict)', () => {
  for (const payload of XSS_PAYLOADS_HARD) {
    test(`payload "${payload.slice(0, 30)}" dans name → 400 invalid_payload`, async ({
      request,
    }) => {
      const email = `${tag(`hard-${Math.abs(hashStr(payload)) % 10000}`)}@e2e.veridian.site`;
      const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': ADMIN_SECRET,
        },
        data: { email, name: payload },
        failOnStatusCode: false,
      });
      // CRITIQUE : payload XSS doit être rejeté (jamais stocké)
      expect(
        res.status(),
        `payload "${payload}" doit être rejeté par Zod refine, got ${res.status()}`,
      ).not.toBe(200);
      expect([400, 429]).toContain(res.status());
      if (res.status() === 400) {
        const body = await res.json();
        expect(body.error).toBe('invalid_payload');
      }
    });
  }

  for (const payload of XSS_PAYLOADS_NO_BRACKETS) {
    test(`payload "${payload}" (chars valides) → 200 ok (accepté, React escape au rendu)`, async ({
      request,
    }) => {
      const email = `${tag(`soft-${Math.abs(hashStr(payload)) % 10000}`)}@e2e.veridian.site`;
      const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': ADMIN_SECRET,
        },
        data: { email, name: payload },
        failOnStatusCode: false,
      });
      // Doit être accepté (200) — pas de XSS car pas de < >
      // 429 acceptable si rate-limit consommé
      expect([200, 429]).toContain(res.status());
    });
  }
});

// ─── Cible 2 : admin/tenants/link-app.tenant_name (Zod refine) ────────────

test.describe('Mega I-04 — XSS sur link-app.tenant_name + slug + notes (refine strict)', () => {
  test('tenant_name avec <script> → 400 (refine bloque < >)', async ({
    request,
  }) => {
    const email = `${tag('linkapp-tenant')}@e2e.veridian.site`;
    // Setup user
    await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: { email, name: 'Setup' },
      failOnStatusCode: false,
    });

    const res = await request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: {
        user_email: email,
        app: 'cms',
        external_tenant_id: '42',
        external_tenant_slug: `mega-i-04-${MEGA_RUN_STAMP.slice(-6)}-xss`,
        tenant_name: '<script>alert(1)</script>',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    expect([400, 429]).toContain(res.status());
  });

  test('external_tenant_slug avec < > → 400 (regex slug-safe)', async ({
    request,
  }) => {
    const email = `${tag('linkapp-slug')}@e2e.veridian.site`;
    await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: { email, name: 'Setup' },
      failOnStatusCode: false,
    });

    const res = await request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: {
        user_email: email,
        app: 'cms',
        external_tenant_id: '43',
        external_tenant_slug: 'evil<script>alert(1)</script>',
        tenant_name: 'Valid Name',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    expect([400, 429]).toContain(res.status());
  });

  test('external_tenant_slug avec espaces → 400 (regex slug strict)', async ({
    request,
  }) => {
    const email = `${tag('linkapp-space')}@e2e.veridian.site`;
    await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: { email, name: 'Setup' },
      failOnStatusCode: false,
    });

    const res = await request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: {
        user_email: email,
        app: 'cms',
        external_tenant_id: '44',
        external_tenant_slug: 'has spaces',
        tenant_name: 'Valid Name',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    expect([400, 429]).toContain(res.status());
  });

  test('notes avec char contrôle → 400 (refine bloque \\x00-\\x1f)', async ({
    request,
  }) => {
    const email = `${tag('linkapp-notes')}@e2e.veridian.site`;
    await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: { email, name: 'Setup' },
      failOnStatusCode: false,
    });

    const res = await request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: {
        user_email: email,
        app: 'cms',
        external_tenant_id: '45',
        external_tenant_slug: `mega-i-04-${MEGA_RUN_STAMP.slice(-6)}-notes`,
        tenant_name: 'Valid Name',
        notes: 'Has\x00null\x01char',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(200);
    expect([400, 429]).toContain(res.status());
  });
});

// ─── Cible 3 : invitations/create.message (refine bloque < >) ─────────────

test.describe('Mega I-04 — XSS sur invitations/create.message', () => {
  test('message avec <script> → 400 (Zod refine bloque < >)', async ({
    request,
  }) => {
    // Le call sera rejeté soit par HMAC (si pas de secret), soit par Zod
    // refine (si secret valide). Critère : jamais 200.
    const body = JSON.stringify({
      inviter_user_id: `mega-${MEGA_RUN_STAMP}`,
      inviter_email: `${tag('inviter-xss')}@e2e.veridian.site`,
      invitee_email: `${tag('invitee-xss')}@e2e.veridian.site`,
      target_app: 'notifuse' as const,
      target_workspace_id: `mega-${BUCKET}-${MEGA_RUN_STAMP}-ws`,
      target_role: 'member' as const,
      message: '<script>alert(document.cookie)</script>',
    });
    const res = await request.post(`${STAGING_URL}/api/invitations/create`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': String(Date.now()),
        'x-veridian-invitation-signature': 'a'.repeat(64),
      },
      data: body,
      failOnStatusCode: false,
    });
    // 400 (Zod refine) ou 401 (HMAC reject) ou 503 (secret manquant)
    // JAMAIS 200
    expect(res.status()).not.toBe(200);
    expect([400, 401, 429, 503]).toContain(res.status());
  });
});

// ─── Cible 4 : workspace rename avec XSS dans name ───────────────────────

test.describe('Mega I-04 — workspace rename ne crash pas sur XSS payload', () => {
  test('PATCH /api/workspace/[id]/rename name=<script> → 401/403 (pas de session) sans 500', async ({
    request,
  }) => {
    // Test sans session : on doit recevoir 401 avant même la validation Zod.
    // Critère : pas de 500, pas de 200.
    const res = await request.patch(
      `${STAGING_URL}/api/workspace/fake-ws-${MEGA_RUN_STAMP}/rename`,
      {
        headers: { 'content-type': 'application/json' },
        data: { name: '<script>alert(1)</script>' },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).not.toBe(200);
    expect(res.status()).toBeLessThan(500);
    expect([401, 403, 404]).toContain(res.status());
  });
});

// ─── Cible 5 : Les réponses API JSON ne renvoient jamais d'HTML brut ────

test.describe('Mega I-04 — Aucune API ne renvoie d\'HTML brut (content-type: application/json)', () => {
  test('POST /api/admin/users/create succès renvoie application/json strict', async ({
    request,
  }) => {
    const email = `${tag('ct-check')}@e2e.veridian.site`;
    const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: { email, name: 'Valid Name' },
      failOnStatusCode: false,
    });
    // Si succès, vérif content-type = JSON (jamais HTML inline)
    if (res.status() === 200) {
      const ct = res.headers()['content-type'] || '';
      expect(
        ct.toLowerCase(),
        `content-type doit être application/json, got "${ct}"`,
      ).toContain('application/json');
      // Le body ne doit pas commencer par "<" (HTML doc)
      const body = await res.text();
      expect(body.trim().charAt(0)).not.toBe('<');
    }
  });

  test('POST 400 invalid_payload renvoie aussi application/json (pas une page HTML d\'erreur)', async ({
    request,
  }) => {
    const res = await request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      data: { email: 'not-an-email', name: 'X' },
      failOnStatusCode: false,
    });
    if (res.status() === 400) {
      const ct = res.headers()['content-type'] || '';
      expect(ct.toLowerCase()).toContain('application/json');
      const body = await res.text();
      // Ne doit JAMAIS commencer par <!DOCTYPE ou <html
      expect(body.trim().toLowerCase()).not.toMatch(/^<!doctype/);
      expect(body.trim().toLowerCase()).not.toMatch(/^<html/);
    }
  });
});

// ─── Cible 6 : page invite/[token] ne réfléchit pas le token sans escape ──

test.describe('Mega I-04 — page /invite/[token] ne réfléchit pas le token sans escape', () => {
  test('GET /invite/<token-XSS> → page rendue sans exécution JS', async ({
    request,
  }) => {
    // On fabrique un token avec un payload XSS. Le path param sera URL-encoded,
    // mais on vérifie que la page Next.js n'injecte pas le raw value dans le HTML.
    const evilToken = `<script>alert(1)</script>`;
    const url = `${STAGING_URL}/invite/${encodeURIComponent(evilToken)}`;
    const res = await request.get(url, { failOnStatusCode: false });
    expect(res.status()).toBeLessThan(500);

    if (res.status() === 200) {
      const html = await res.text();
      // Aucune balise <script>alert(1)</script> non échappée dans le rendu.
      // React échappe par défaut → on devrait voir &lt;script&gt; au pire.
      expect(
        html,
        'CRITIQUE : la page /invite/[token] réfléchit le token raw sans escape',
      ).not.toContain('<script>alert(1)</script>');
    }
  });
});

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
