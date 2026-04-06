#!/usr/bin/env node

/**
 * EXPORT BILLING CONFIG → JSON
 *
 * Ce script importe billing.config.ts et exporte la config en JSON
 * pour être utilisée par sync-billing-to-stripe.mjs
 *
 * Usage:
 *   node scripts/billing/export-config.mjs
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('📦 Export de la configuration billing...\n');

// Utiliser tsx pour importer le fichier TypeScript et exporter en JSON
const code = `
import { PAID_PLANS, METERED_PRODUCTS, BILLING_NAMESPACE, WORKFLOW_METER_ID } from './config/billing.config';
console.log(JSON.stringify({ plans: PAID_PLANS, metered: METERED_PRODUCTS, namespace: BILLING_NAMESPACE, meterId: WORKFLOW_METER_ID }, null, 2));
`;

try {
  const output = execSync(
    `npx tsx --eval "${code.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
    { cwd: path.join(__dirname, '../..'), encoding: 'utf-8' }
  );

  const configPath = path.join(__dirname, '.billing-config.json');
  fs.writeFileSync(configPath, output);

  console.log('✅ Configuration exportée vers:', configPath);
  console.log(`   ${JSON.parse(output).plans.length} plans exportés\n`);
} catch (error) {
  console.error('❌ Erreur lors de l\'export:', error.message);
  process.exit(1);
}
