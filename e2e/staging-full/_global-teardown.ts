/**
 * staging-full — `_global-teardown.ts`
 *
 * Cleanup final post-run de la suite `e2e/staging-full/*.spec.ts`.
 * Référencé par `playwright.staging-full.config.ts:globalTeardown`.
 *
 * Pourquoi : Playwright cleanup correctement les `BrowserContext`/`Page`
 * créés via les **fixtures** (`test('...', async ({ page }) => ...)`),
 * mais quand une spec fait `await playwright.chromium.launch()` à la main
 * et qu'une assertion pète AVANT le `await browser.close()`, le process
 * Chromium reste vivant. Constat 2026-05-23 : 49 chromium leftover après
 * un run.
 *
 * Stratégie 3 niveaux (cf. MEGA `_global-teardown.ts`) :
 *   1. `test.afterEach` / `try { ... } finally { browser.close() }` par spec
 *   2. `withCleanContext()` helper réutilisable (cf. `_cleanup-helper.ts`)
 *   3. Filet de sécurité : ce `globalTeardown` qui pkill les orphelins
 *
 * On scope le pkill aux processus avec `--remote-debugging-pipe` dans la
 * ligne de commande (signature spécifique des chromiums lancés par
 * Playwright) pour éviter de tuer le Chrome quotidien de Robert qui
 * tourne en parallèle.
 *
 * Best-effort : on swallow toutes les erreurs (un teardown qui crash
 * masquerait les vrais bugs en faisant péter le run alors que les tests
 * sont peut-être verts).
 */
import type { FullConfig } from '@playwright/test';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const { execSync } = await import('node:child_process');

  let beforeCount = 0;
  try {
    const out = execSync('pgrep -c chromium 2>/dev/null || echo 0', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    beforeCount = Number(out.trim()) || 0;
  } catch {
    /* no-op */
  }

  // Kill processus Playwright orphelins.
  // Signature `--remote-debugging-pipe` = lancé par Playwright (pas le
  // Chrome quotidien de l'utilisateur qui utilise `--remote-debugging-port`).
  try {
    execSync('pkill -9 -f "chromium.*--remote-debugging-pipe" 2>/dev/null || true', {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    /* no-op */
  }

  // Filet additionnel : kill playwright-core helper processes orphelins.
  try {
    execSync('pkill -9 -f "playwright-core/lib/server" 2>/dev/null || true', {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    /* no-op */
  }

  let afterCount = 0;
  try {
    const out = execSync('pgrep -c chromium 2>/dev/null || echo 0', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    afterCount = Number(out.trim()) || 0;
  } catch {
    /* no-op */
  }

  const killed = Math.max(0, beforeCount - afterCount);
  console.log(
    `\n[staging-full globalTeardown] chromium processes : ${beforeCount} avant → ${afterCount} après (${killed} cleanés)\n`,
  );
}
