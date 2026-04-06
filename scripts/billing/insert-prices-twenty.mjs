#!/usr/bin/env node
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '../../../infra/.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
let envVars = {};

envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) envVars[match[1]] = match[2].replace(/^"|"$/g, '');
});

const stripe = new Stripe(envVars.STRIPE_SECRET_KEY_LIVE, {
  apiVersion: '2024-12-18.acacia'
});

console.log('🔴 MODE: PRODUCTION (Stripe LIVE)\n');
console.log('📥 Insertion manuelle des prix dans Twenty DB...\n');

// Récupérer les prix actifs
const products = await stripe.products.list({ limit: 100 });
const veridianProducts = products.data.filter(p =>
  p.metadata?.namespace === 'veridian' &&
  p.metadata?.productKey === 'BASE_PRODUCT' &&
  p.active === true
);

const sqlStatements = [];

for (const product of veridianProducts) {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });

  console.log(`📦 ${product.name} (${product.id})`);

  for (const price of prices.data) {
    const amount = price.unit_amount || 0;
    const interval = price.recurring?.interval || 'month';
    const currency = price.currency.toUpperCase();
    const taxBehavior = price.tax_behavior?.toUpperCase() || 'UNSPECIFIED';
    const type = price.type === 'one_time' ? 'ONE_TIME' : 'RECURRING';
    const billingScheme = price.billing_scheme === 'tiered' ? 'TIERED' : 'PER_UNIT';
    const usageType = price.recurring?.usage_type === 'metered' ? 'METERED' : 'LICENSED';
    const recurring = JSON.stringify(price.recurring || {}).replace(/'/g, "''");

    const sql = `INSERT INTO core."billingPrice" (
  "stripePriceId",
  active,
  "stripeProductId",
  currency,
  nickname,
  "taxBehavior",
  type,
  "billingScheme",
  recurring,
  "unitAmount",
  "usageType",
  interval,
  "createdAt",
  "updatedAt"
) VALUES (
  '${price.id}',
  ${price.active},
  '${product.id}',
  '${currency}',
  ${price.nickname ? `'${price.nickname}'` : 'NULL'},
  '${taxBehavior}',
  '${type}',
  '${billingScheme}',
  '${recurring}'::jsonb,
  ${amount},
  '${usageType}',
  '${interval}',
  NOW(),
  NOW()
) ON CONFLICT ("stripePriceId") DO UPDATE SET
  active = EXCLUDED.active,
  "unitAmount" = EXCLUDED."unitAmount",
  "updatedAt" = NOW();`;

    sqlStatements.push(sql);

    const amountEur = (amount / 100).toFixed(2);
    console.log(`   💰 ${amountEur} EUR/${interval} (${price.id})`);
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n📝 ${sqlStatements.length} requêtes SQL à exécuter\n`);

// Écrire le SQL dans un fichier
const sqlFile = '/tmp/insert-twenty-prices.sql';
fs.writeFileSync(sqlFile, sqlStatements.join('\n\n'));
console.log(`📄 SQL écrit dans: ${sqlFile}\n`);

// Exécuter via SSH
console.log('🚀 Exécution sur le serveur de production...\n');

try {
  // Copier le fichier SQL sur le serveur
  execSync(`scp ${sqlFile} ovh:/tmp/insert-twenty-prices.sql`, { stdio: 'inherit' });

  // Exécuter le SQL dans le container Twenty
  const result = execSync(
    `ssh ovh "cd ~/twenty-saas/00-Global-saas/infra && docker compose exec -T twenty-postgres psql -U twenty -d twenty -f /tmp/insert-twenty-prices.sql"`,
    { encoding: 'utf-8' }
  );

  console.log(result);
  console.log('\n✅ Insertion terminée !');

  // Vérification
  const countResult = execSync(
    `ssh ovh "cd ~/twenty-saas/00-Global-saas/infra && docker compose exec twenty-postgres psql -U twenty -d twenty -c \\"SELECT COUNT(*) as total FROM core.\\\\\\\"billingPrice\\\\\\\" WHERE \\\\\\\"deletedAt\\\\\\\" IS NULL AND active = true;\\""`,
    { encoding: 'utf-8' }
  );

  console.log('\n📊 Vérification:');
  console.log(countResult);

} catch (error) {
  console.error('❌ Erreur:', error.message);
  console.log('\n📋 SQL à exécuter manuellement:');
  console.log(sqlStatements.join('\n\n'));
}
