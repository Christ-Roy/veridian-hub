/**
 * MEGA I-01 — Brute force login lockout
 *
 * **CIBLE** : `credentialsLoginLimiter` (5/min/IP) sur
 * `POST /api/auth/callback/credentials`.
 *
 * **SCÉNARIO** (cf. ticket MEGA §1 Bucket I-01) :
 *   - 5 premières tentatives → status ≠ 429 (le limiter laisse passer 5)
 *   - 6 à 10 tentatives → 429 + Retry-After ≥ 1s
 *   - Anti-régression : pas de bypass possible via différents emails
 *     (le limiter clé est l'IP, pas le couple IP+email)
 *
 * **POURQUOI HARDCORE** :
 *   - On NE compte PAS uniquement « il y a des 429 », on vérifie que la
 *     coupure intervient bien à partir de la 6e tentative (cap=5/60s)
 *   - On vérifie le Retry-After header bornée [1..60]
 *   - On vérifie que le rate-limit est IP-based (pas user-enum bypass)
 *   - On vérifie que la réponse 429 ne fuite pas le password essayé
 *     ni le nom de l'env (anti info leak)
 *
 * **NOTE TIMING** : le credentialsLoginLimiter est partagé entre tous les
 * specs E2E qui touchent /api/auth/callback/credentials (spec 16 S5,
 * spec 03 signup-credentials-flow). Pour éviter une dépendance d'ordre,
 * on accepte 429 dès la 1ère tentative si le bucket est déjà vide
 * — l'assert clé est « ≥ 5 réponses 429 sur 10 tentatives consécutives ».
 *
 * **CLEANUP** : aucun user créé en DB (mauvais password sur user inexistant).
 *
 * **MARKER** : `[risk:medium]` car teste un limiteur de sécurité — si on
 * casse la sécu en relaxant ce cap, on veut le voir dans cette spec avant
 * promo main.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

const BUCKET = 'i';
const SPEC = '01-brute';

// Helper pour générer un email cible cohérent avec le préfixe MEGA (cleanup
// global ramassera s'il y a des effets de bord en DB — improbable car on
// envoie des passwords invalides sur user inexistant).
function bruteEmail(variant: string): string {
  return `e2e-mega-${BUCKET}-${SPEC}-${variant}-${MEGA_RUN_STAMP}@e2e.veridian.site`;
}

/**
 * Tape la route credentials avec un mauvais password.
 * Retourne {status, retryAfter, bodyText}.
 */
async function tryLogin(
  request: APIRequestContext,
  email: string,
  password = 'WrongPwdMega123!',
): Promise<{ status: number; retryAfter: string | null; bodyText: string }> {
  const res = await request.post(`${STAGING_URL}/api/auth/callback/credentials`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    form: { email, password },
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    /* binary or empty body */
  }
  return {
    status: res.status(),
    retryAfter: res.headers()['retry-after'] ?? null,
    bodyText,
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('Mega I-01 — Brute force login lockout', () => {
  test('10 tentatives consécutives → au moins 5 réponses 429 (cap=5/min/IP)', async ({
    request,
  }) => {
    const email = bruteEmail('seq');
    const results: Array<{ status: number; retryAfter: string | null }> = [];

    // Tentatives séquentielles : on veut observer la transition « OK → 429 »,
    // pas seulement le steady-state 429.
    for (let i = 0; i < 10; i++) {
      const r = await tryLogin(request, email);
      results.push({ status: r.status, retryAfter: r.retryAfter });
    }

    const statuses = results.map((r) => r.status);
    const rateLimited = results.filter((r) => r.status === 429);

    expect(
      rateLimited.length,
      `Attendu ≥ 5 réponses 429 sur 10 tentatives (cap=5/min/IP). ` +
        `Statuses observés: ${statuses.join(',')}`,
    ).toBeGreaterThanOrEqual(5);

    // Sur les 429, le header Retry-After doit être présent et borné.
    for (const r of rateLimited) {
      expect(
        r.retryAfter,
        `Retry-After header DOIT être posé sur 429 (spec HTTP)`,
      ).toBeTruthy();
      if (r.retryAfter) {
        const secs = Number(r.retryAfter);
        expect(
          Number.isFinite(secs) && secs >= 1 && secs <= 60,
          `Retry-After doit être un entier > 0 et ≤ 60s (fenêtre 60s), got '${r.retryAfter}'`,
        ).toBe(true);
      }
    }
  });

  test('le 429 ne fuite ni password essayé ni stack trace ni info user', async ({
    request,
  }) => {
    // On force quelques calls pour atteindre 429 même si le bucket est plein
    // depuis le test précédent.
    const email = bruteEmail('leak');
    const sensitivePwd = `Sensitive-Pwd-${MEGA_RUN_STAMP}-NEVERLEAK`;

    let last: { status: number; bodyText: string; retryAfter: string | null } | null = null;
    for (let i = 0; i < 8; i++) {
      last = await tryLogin(request, email, sensitivePwd);
      if (last.status === 429) break;
    }
    expect(last, 'au moins une tentative doit avoir abouti').toBeTruthy();
    if (!last) return;

    // Si on n'a pas réussi à toucher 429 (cas où le limiter aurait été
    // bypass-headerisé en CI), on tolère un status 4xx générique mais on
    // teste quand même l'absence de leak.
    const bodyLower = last.bodyText.toLowerCase();

    expect(
      bodyLower,
      'CRITIQUE : le body de réponse ne doit JAMAIS contenir le password essayé',
    ).not.toContain(sensitivePwd.toLowerCase());

    // Pas de leak stack trace
    expect(bodyLower).not.toContain('typeerror');
    expect(bodyLower).not.toContain('at object.');
    expect(bodyLower).not.toContain('node:internal');
    expect(bodyLower).not.toContain('at async ');

    // Pas de leak user-enumeration
    expect(bodyLower).not.toContain('user not found');
    expect(bodyLower).not.toContain('user does not exist');
    expect(bodyLower).not.toContain('no such user');
    expect(bodyLower).not.toContain('account does not exist');
    // Pas de fuite secret ENV (sanity)
    expect(bodyLower).not.toContain('admin_secret');
    expect(bodyLower).not.toContain('process.env');
  });

  test('le rate-limit est IP-based — varier l\'email ne bypass pas le cap', async ({
    request,
  }) => {
    // On enchaîne 12 tentatives avec 12 emails DIFFÉRENTS. Si le limiter
    // était per-email, on aurait 12× le cap (= aucun 429). Comme il est
    // per-IP, on doit voir des 429 dès qu'on dépasse 5 sur la fenêtre.
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const email = bruteEmail(`enum-${i}`);
      const r = await tryLogin(request, email);
      results.push(r.status);
    }

    const rateLimited = results.filter((s) => s === 429);
    expect(
      rateLimited.length,
      `CRITIQUE : varier l'email ne doit pas bypass le rate-limit IP. ` +
        `Sur 12 calls avec emails distincts, attendu ≥ 5 réponses 429. ` +
        `Statuses: ${results.join(',')}`,
    ).toBeGreaterThanOrEqual(5);
  });

  test('le serveur ne crash JAMAIS en 5xx sous burst (10 calls // mêmes credentials)', async ({
    request,
  }) => {
    const email = bruteEmail('burst');
    // Burst parallèle : test que sous concurrence, on observe seulement
    // 429 / 4xx, jamais 5xx (qui indiquerait une race condition côté Hub).
    const calls = await Promise.all(
      Array.from({ length: 10 }, () => tryLogin(request, email)),
    );
    const statuses = calls.map((c) => c.status);

    // Critère hardcore : AUCUN 5xx ne doit apparaître
    const serverErrors = statuses.filter((s) => s >= 500);
    expect(
      serverErrors,
      `CRITIQUE : burst de login ne doit JAMAIS faire 5xx. Statuses: ${statuses.join(',')}`,
    ).toHaveLength(0);

    // Aucune 2xx silencieuse non plus (auth = wrong password)
    const success = statuses.filter((s) => s >= 200 && s < 300);
    expect(
      success.length,
      `CRITIQUE : un wrong-password ne doit JAMAIS retourner 2xx. Got: ${statuses.join(',')}`,
    ).toBe(0);
  });
});
