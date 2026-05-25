/**
 * staging-full — `_cleanup-helper.ts`
 *
 * Helpers réutilisables pour éviter les fuites de ressources Playwright
 * quand une spec lance `playwright.chromium.launch()` à la main au lieu
 * d'utiliser le fixture `page` / `context` de `test('...', async ({ ...
 * }) => ...)`.
 *
 * Pattern recommandé dans une spec :
 *
 * ```ts
 * test('mon flow', async ({ playwright }) => {
 *   await withCleanBrowser(playwright, async (browser) => {
 *     await withCleanContext(browser, { storageState: cookies }, async (context) => {
 *       const page = await context.newPage();
 *       await page.goto('/dashboard');
 *       // assertions ici — si elles pètent, browser/context sont quand
 *       // même fermés par withCleanBrowser/withCleanContext
 *     });
 *   });
 * });
 * ```
 *
 * Garanties :
 *   - `browser.close()` / `context.close()` appelés MÊME en cas
 *     d'exception (try/finally)
 *   - L'exception originale est re-thrown (Playwright voit le test rouge)
 *   - Erreur de close() avalée silencieusement (ne masque pas l'erreur
 *     originale ni n'invente une nouvelle erreur)
 */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
} from '@playwright/test';

/**
 * Type du fixture `playwright` exposé par `test('...', async ({
 * playwright }) => ...)` — pas exporté nommément par `@playwright/test`,
 * on dérive depuis `typeof import(...)` comme dans les specs existantes.
 */
type PlaywrightFixture = typeof import('@playwright/test');

/**
 * Lance un Chromium éphémère, exécute `fn(browser)`, garantit la
 * fermeture du browser même en cas d'erreur.
 */
export async function withCleanBrowser<T>(
  playwright: PlaywrightFixture,
  fn: (browser: Browser) => Promise<T>,
  launchOptions?: LaunchOptions,
): Promise<T> {
  const browser = await playwright.chromium.launch(launchOptions);
  try {
    return await fn(browser);
  } finally {
    try {
      await browser.close();
    } catch {
      /* best effort — ne pas masquer l'erreur originale */
    }
  }
}

/**
 * Crée un BrowserContext, exécute `fn(context)`, garantit la fermeture
 * du context même en cas d'erreur.
 */
export async function withCleanContext<T>(
  browser: Browser,
  options: BrowserContextOptions,
  fn: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await fn(context);
  } finally {
    try {
      await context.close();
    } catch {
      /* best effort — ne pas masquer l'erreur originale */
    }
  }
}
