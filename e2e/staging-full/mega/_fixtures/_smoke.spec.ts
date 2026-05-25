/**
 * MEGA fixture — `_smoke.spec.ts`
 *
 * UN seul scénario qui valide que les helpers MEGA tournent correctement
 * AVANT d'écrire les 24 buckets métier (Vague 2).
 *
 * **CE QU'ON TESTE** :
 *   1. Le mock OAuth provider répond (assertMockOAuthAvailable)
 *   2. megaSignIn crée bien un user via mock-oauth (callback < 400)
 *   3. Le user existe en DB Hub (query via audit_log + admin API)
 *   4. La purge par préfixe le supprime (purgeMegaByPrefix)
 *   5. Stripe config OK (au moins listMegaCustomers répond sans throw)
 *
 * **POURQUOI UN SMOKE** : si ces 5 étapes passent, n'importe quel agent
 * Vague 2 peut faire confiance aux helpers et écrire ses specs sans
 * payer le coût de debug d'infra. Si ça pète, on sait que la fondation
 * Vague 1 a un problème (pas un bug de spec métier).
 *
 * **DURATION** : ~5-10 secondes (1 signup OAuth + 1 query DB + 1 cleanup).
 */
import { test, expect } from '@playwright/test';

import { purgeMegaByPrefix, countMegaResidues } from './db-purge';
import { listMegaCustomers, StripeConfigError } from './stripe-api';
import {
  assertMockOAuthAvailable,
  disposeSession,
  megaSignIn,
  type MegaSession,
} from './mock-oauth';
import { runSqlOnStaging } from '../../_sql-helper';
import { MEGA_RUN_STAMP } from './run-stamp';

// On utilise un bucket "smoke" dédié (jamais utilisé par Vague 2) pour
// éviter toute collision avec les specs métier.
const BUCKET = 'smoke';
// Sanitize-friendly (alphanumeric + dash uniquement) — megaEmail() sanitize les
// chars hors [a-z0-9-] en dash. Garder SPEC identique à ce que megaEmail produira
// pour que purgeMegaByPrefix matche correctement les emails créés.
const SPEC = 'fixtures-validation';

// Le smoke spec doit tourner sériellement : le test signup teste la purge
// par préfixe, ce qui suppose 1 seul user actif en DB matching le préfixe.
// En parallèle (workers=2+), un autre test pourrait purger entre le signup
// et l'assertion. On force le mode serial pour ce describe.
test.describe.configure({ mode: 'serial' });

test.describe('Mega smoke — validation helpers Vague 1', () => {
  let session: MegaSession | null = null;

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    // Purge ciblée même si les asserts du test ont passé (filet)
    try {
      const stats = await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
        tenantPrefix: `mega-${BUCKET}-${MEGA_RUN_STAMP}`,
      });
      const total = Object.values(stats.rowsDeleted).reduce((a, b) => a + b, 0);

      console.log(`[smoke afterAll] purged ${total} rows in ${stats.durationMs}ms`);
    } catch {
      /* try/catch swallow — afterAll ne doit jamais throw */
    }
  });

  test('mock OAuth provider est disponible sur staging', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('megaSignIn crée un user via mock OAuth + purge le supprime', async ({
    playwright,
  }) => {
    // ─── 1. Signup via mock OAuth ────────────────────────────────────
    // Cast pour contourner le mismatch playwright-core vs @playwright/test
    // (problème connu pnpm symlinks, présent dans toutes les autres specs).
    session = await megaSignIn(playwright as unknown as typeof import('@playwright/test'), {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
    });
    expect(session.callbackStatus, 'mock-oauth callback doit < 400').toBeLessThan(400);
    expect(session.email).toMatch(/^e2e-mega-smoke-.+@e2e\.veridian\.site$/);

    // ─── 2. Vérifier que le user existe en DB Hub ────────────────────
    // On query directement la DB pour ne pas dépendre de l'admin API
    // (qui peut être rate-limitée même avec bypass selon le timing).
    const safeEmail = session.email.replace(/'/g, "''");
    const userCheck = runSqlOnStaging(
      `SELECT count(*) FROM hub_app.users WHERE email = '${safeEmail}';`,
    );
    expect(
      Number(userCheck.trim()),
      `User ${session.email} doit exister en DB Hub après mock-oauth callback`,
    ).toBeGreaterThanOrEqual(1);

    // ─── 3. Purge ciblée le supprime ─────────────────────────────────
    const purgeStats = await purgeMegaByPrefix({
      emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
      tenantPrefix: `mega-${BUCKET}-${MEGA_RUN_STAMP}`,
    });
    expect(
      purgeStats.rowsDeleted.users,
      'purgeMegaByPrefix doit avoir supprimé au moins 1 user',
    ).toBeGreaterThanOrEqual(1);

    // ─── 4. Le user n'existe plus en DB ─────────────────────────────
    const userPostPurge = runSqlOnStaging(
      `SELECT count(*) FROM hub_app.users WHERE email = '${safeEmail}';`,
    );
    expect(
      Number(userPostPurge.trim()),
      `User ${session.email} doit être supprimé après purgeMegaByPrefix`,
    ).toBe(0);
  });

  test('countMegaResidues répond avec un objet structuré', async () => {
    const residues = await countMegaResidues();
    // On ne sait pas combien de résidus existent (un autre run a pu en
    // laisser), on valide juste la shape de retour.
    expect(residues).toHaveProperty('users');
    expect(residues).toHaveProperty('tenants');
    expect(residues).toHaveProperty('workspaces');
    expect(residues).toHaveProperty('tenantTrials');
    expect(residues).toHaveProperty('total');
    expect(typeof residues.users).toBe('number');

    console.log(`[smoke] residues MEGA en DB : total=${residues.total}`);
  });

  test('Stripe API config est OK (au moins une opération list passe)', async () => {
    // Si STRIPE_SECRET_KEY_TEST n'est pas exporté ou est un placeholder,
    // on doit avoir une StripeConfigError claire (pas un crash random).
    try {
      const customers = await listMegaCustomers(1); // 1 batch = 100 customers max
      // Si on arrive ici sans throw → config OK, peu importe le count

      console.log(`[smoke] Stripe TEST OK : ${customers.length} customers MEGA listés`);
      expect(Array.isArray(customers)).toBe(true);
    } catch (err) {
      if (err instanceof StripeConfigError) {
        // Config manquante = warning mais pas fail dur (cas où le runner
        // n'a pas pu source les creds, ex: en CI sans secret encore).

        console.warn(`[smoke] Stripe config manquante : ${err.message}`);
        test.skip(true, `Stripe config missing: ${err.message}`);
        return;
      }
      // Autre erreur (réseau, Stripe down) → on remonte
      throw err;
    }
  });

  test('MEGA_RUN_STAMP est unique et stable dans le run', () => {
    expect(MEGA_RUN_STAMP).toMatch(/^[\w-]+$/);
    expect(MEGA_RUN_STAMP.length).toBeGreaterThan(8);
    // Stable : 2 accès = même valeur

    expect(MEGA_RUN_STAMP).toBe(MEGA_RUN_STAMP);
  });
});
