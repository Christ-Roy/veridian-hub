/**
 * MEGA fixture — `_global-teardown.ts`
 *
 * Cleanup final post-run de toute la suite MEGA. Garanti par Playwright
 * même en cas de crash worker. Référencé par `playwright.mega.config.ts:
 * globalTeardown`.
 *
 * **STRATÉGIE 3 NIVEAUX** :
 *   1. `test.afterEach` (par test)  : fermeture contexts Playwright
 *   2. `test.afterAll` (par spec)   : purge DB Hub par préfixe spec
 *   3. `globalTeardown` (ce file)   : cleanup cross-spec + cross-app +
 *      Stripe + processus orphelins + vérification finale
 *
 * **CE QU'ON FAIT** :
 *   1. Purge Stripe (customers test + subs test) via API
 *   2. Purge DB Hub (`e2e-mega-%`)
 *   3. Purge DB Notifuse downstream (`e2e-mega-%`)
 *   4. Purge DB Prospection downstream (`e2e-mega-%`)
 *   5. Kill processus chromium / playwright orphelins
 *   6. Vérif finale : compte les rows résiduelles → warn si > 0
 *
 * **ROBUSTESSE** :
 *   - Chaque étape try/catch indépendamment (un fail d'une étape ne
 *     bypass pas les suivantes)
 *   - Stats finales loggées en stdout (lisible par CI)
 *   - Retour 0 même si certains cleanups failed (sinon Playwright fail
 *     le run alors que les tests sont peut-être verts)
 *
 * **PERF** : ~5-10 secondes en run nominal (Stripe = 2-3s, DBs = 2-3s).
 */
import type { FullConfig } from '@playwright/test';

import { countMegaResidues, purgeAllMegaArtifacts } from './db-purge';
import { purgeNotifuseMega, purgeProspectionMega } from './downstream-db';
import { cleanupAllMegaArtifacts, StripeConfigError } from './stripe-api';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const start = Date.now();
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  MEGA E2E — globalTeardown (cleanup post-run)');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ─── 1. Stripe : cancel subs + delete customers ───────────────────
  lines.push('');
  lines.push('[1/5] Stripe cleanup (customers test + subs)...');
  try {
    const stripeStats = await cleanupAllMegaArtifacts();
    lines.push(
      `      ✓ Stripe : ${stripeStats.customersFound} customers, ` +
        `${stripeStats.subsCanceled} subs canceled, ` +
        `${stripeStats.customersDeleted} customers deleted` +
        (stripeStats.errors.length > 0
          ? ` (${stripeStats.errors.length} erreurs non-bloquantes)`
          : ''),
    );
    if (stripeStats.errors.length > 0) {
      for (const e of stripeStats.errors.slice(0, 5)) {
        lines.push(`        ⚠ ${e}`);
      }
      if (stripeStats.errors.length > 5) {
        lines.push(`        ... +${stripeStats.errors.length - 5} autres erreurs`);
      }
    }
  } catch (err) {
    if (err instanceof StripeConfigError) {
      lines.push(`      ⚠ Stripe skip : ${err.message}`);
    } else {
      lines.push(
        `      ✗ Stripe failed : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── 2. DB Hub : purge globale e2e-mega-% ─────────────────────────
  lines.push('');
  lines.push('[2/5] DB Hub purge (e2e-mega-%@e2e.veridian.site)...');
  try {
    const purgeStats = await purgeAllMegaArtifacts();
    const total = Object.values(purgeStats.rowsDeleted).reduce((a, b) => a + b, 0);
    lines.push(
      `      ✓ Hub : ${total} rows supprimées en ${purgeStats.durationMs}ms`,
    );
    if (total > 0) {
      const breakdown = Object.entries(purgeStats.rowsDeleted)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ');
      lines.push(`        Détail : ${breakdown}`);
    }
  } catch (err) {
    lines.push(
      `      ✗ Hub purge failed : ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ─── 3. DB Notifuse downstream ────────────────────────────────────
  lines.push('');
  lines.push('[3/5] DB Notifuse downstream purge...');
  try {
    const notifStats = purgeNotifuseMega();
    lines.push(
      `      ✓ Notifuse : ${notifStats.workspacesDeleted} workspaces, ` +
        `${notifStats.usersDeleted} users supprimés`,
    );
  } catch (err) {
    lines.push(
      `      ✗ Notifuse purge failed : ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ─── 4. DB Prospection downstream ─────────────────────────────────
  lines.push('');
  lines.push('[4/5] DB Prospection downstream purge...');
  try {
    const prospStats = purgeProspectionMega();
    lines.push(
      `      ✓ Prospection : ${prospStats.workspacesDeleted} workspaces, ` +
        `${prospStats.usersDeleted} users supprimés`,
    );
  } catch (err) {
    lines.push(
      `      ✗ Prospection purge failed : ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ─── 5. Processus orphelins (best-effort, ne fail jamais) ─────────
  lines.push('');
  lines.push('[5/5] Kill processus orphelins (chromium, playwright)...');
  try {
    const { execSync } = await import('node:child_process');
    let killed = 0;
    try {
      execSync('pkill -f chromium-browser 2>/dev/null || true', { timeout: 5000 });
      killed++;
    } catch {
      /* no-op */
    }
    try {
      execSync('pkill -f playwright-core 2>/dev/null || true', { timeout: 5000 });
      killed++;
    } catch {
      /* no-op */
    }
    // Vérif post-kill : combien de chromium restent ?
    let remaining = 0;
    try {
      const out = execSync('pgrep -c chromium 2>/dev/null || echo 0', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      remaining = Number(out.trim()) || 0;
    } catch {
      /* no-op */
    }
    lines.push(
      `      ✓ pkill chromium/playwright lancé (${killed} signaux envoyés, ${remaining} chromium restants)`,
    );
  } catch (err) {
    lines.push(
      `      ⚠ Kill orphelins failed : ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ─── Vérif finale : compte résidus ────────────────────────────────
  lines.push('');
  lines.push('[Vérif] Comptage résidus post-cleanup...');
  try {
    const residues = await countMegaResidues();
    if (residues.total === 0) {
      lines.push('      ✓ 0 résidu MEGA en DB Hub (cleanup complet)');
    } else if (residues.total === -1) {
      lines.push('      ⚠ Comptage résidus failed (SSH/DB down ?)');
    } else {
      lines.push(
        `      ⚠ ${residues.total} résidus restent : ` +
          `users=${residues.users} tenants=${residues.tenants} ` +
          `workspaces=${residues.workspaces} tenant_trials=${residues.tenantTrials}`,
      );
      lines.push(
        '        → relance `bash scripts/e2e/mega-purge.sh` pour purger manuellement',
      );
    }
  } catch (err) {
    lines.push(
      `      ⚠ Comptage résidus failed : ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  lines.push('');
  lines.push(
    `━━━ globalTeardown terminé en ${((Date.now() - start) / 1000).toFixed(1)}s ━━━`,
  );
  lines.push('');


  console.log(lines.join('\n'));
}
