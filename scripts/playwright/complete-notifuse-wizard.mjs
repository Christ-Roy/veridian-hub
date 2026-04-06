#!/usr/bin/env node
/**
 * Script standalone pour compléter le wizard Notifuse via Playwright
 *
 * Usage:
 *   node complete-notifuse-wizard.mjs [setup_url]
 *
 * Exemple:
 *   node complete-notifuse-wizard.mjs https://notifuse.dev.veridian.site/console/setup
 */

import { chromium } from 'chromium';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Configuration
const SETUP_URL = process.argv[2] || 'https://notifuse.dev.veridian.site/console/setup';
const TIMEOUT = 30000; // 30 secondes

console.log('════════════════════════════════════════════════════');
console.log('🔧 NOTIFUSE WIZARD AUTOMATION');
console.log('════════════════════════════════════════════════════');
console.log(`\n📍 Target URL: ${SETUP_URL}\n`);

/**
 * Exécute le test Playwright
 */
async function completeWizard() {
  try {
    // Commande Playwright
    const command = `npx playwright test tests/notifuse-wizard.spec.ts --config=playwright.config.ts`;

    console.log('🚀 Starting Playwright...');

    const { stdout, stderr } = await execAsync(command, {
      cwd: new URL('.', import.meta.url).pathname,
      env: {
        ...process.env,
        NOTIFUSE_SETUP_URL: SETUP_URL,
        CI: 'true', // Mode headless
      },
      timeout: TIMEOUT,
    });

    if (stdout) {
      console.log(stdout);
    }

    if (stderr && !stderr.includes('node')) {
      console.error('Errors:', stderr);
    }

    console.log('\n✅ Wizard completed successfully!\n');

    return true;
  } catch (error) {
    console.error('\n❌ Error completing wizard:', error.message);

    // Afficher plus de détails si disponible
    if (error.stdout) {
      console.log('STDOUT:', error.stdout);
    }
    if (error.stderr) {
      console.log('STDERR:', error.stderr);
    }

    return false;
  }
}

/**
 * Main execution
 */
(async () => {
  const success = await completeWizard();

  console.log('════════════════════════════════════════════════════');

  if (success) {
    console.log('✅ NOTIFUSE WIZARD COMPLETE');
    console.log('════════════════════════════════════════════════════\n');
    process.exit(0);
  } else {
    console.log('❌ NOTIFUSE WIZARD FAILED');
    console.log('════════════════════════════════════════════════════\n');
    process.exit(1);
  }
})();
