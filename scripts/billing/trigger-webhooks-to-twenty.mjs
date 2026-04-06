#!/usr/bin/env node

/**
 * Script de trigger manuel des webhooks Stripe vers Twenty CRM
 *
 * CONTEXTE:
 * - Le webhook Twenty a été créé APRÈS les produits Stripe
 * - Twenty n'a jamais reçu les événements product.created et price.created
 * - Résultat: Twenty DB est vide (0 produits, 0 prix)
 *
 * SOLUTION:
 * - Forcer Stripe à envoyer des événements product.updated et price.updated
 * - Twenty traite product.updated de la même manière que product.created
 *
 * USAGE:
 *   node scripts/billing/trigger-webhooks-to-twenty.mjs --env=prod --dry-run
 *   node scripts/billing/trigger-webhooks-to-twenty.mjs --env=prod
 */

import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
const envArg = args.find(arg => arg.startsWith('--env='))?.split('=')[1] || 'dev';
const dryRun = args.includes('--dry-run');

// Load environment variables
const envPath = path.join(__dirname, '../../../infra/.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
let envVars = {};

envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) envVars[match[1]] = match[2].replace(/^"|"$/g, '');
});

// Select Stripe key
let stripeKey;
if (envArg === 'prod') {
  stripeKey = envVars.STRIPE_SECRET_KEY_LIVE;
  console.log('🔴 MODE: PRODUCTION (Stripe LIVE)\n');
} else if (envArg === 'preprod') {
  stripeKey = envVars.STRIPE_SECRET_KEY_PREPROD || envVars.STRIPE_SECRET_KEY;
  console.log('🟡 MODE: PREPROD (Stripe TEST)\n');
} else {
  stripeKey = envVars.STRIPE_SECRET_KEY;
  console.log('🟢 MODE: DEV (Stripe TEST)\n');
}

if (!stripeKey) {
  console.error('❌ Erreur: Clé Stripe non trouvée pour l\'environnement', envArg);
  process.exit(1);
}

const stripe = new Stripe(stripeKey, {
  apiVersion: '2024-12-18.acacia'
});

if (dryRun) {
  console.log('🔍 DRY-RUN MODE - Aucune modification ne sera effectuée\n');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Récupérer les produits Veridian
console.log('📦 Récupération des produits Stripe avec namespace "veridian"...\n');

const products = await stripe.products.list({ limit: 100 });
const veridianProducts = products.data.filter(p =>
  p.metadata?.namespace === 'veridian' &&
  p.metadata?.productKey === 'BASE_PRODUCT'
);

if (veridianProducts.length === 0) {
  console.log('⚠️  Aucun produit Veridian trouvé\n');
  console.log('Vérifiez que les produits ont bien metadata.namespace = "veridian"\n');
  process.exit(0);
}

console.log(`✅ ${veridianProducts.length} produits Veridian trouvés:\n`);

for (const product of veridianProducts) {
  console.log(`   📦 ${product.name} (${product.id})`);
  console.log(`      Plan: ${product.metadata.planKey}`);
  console.log('');
}

// Récupérer tous les prix actifs
console.log('💰 Récupération des prix actifs...\n');

const allPrices = [];
for (const product of veridianProducts) {
  const prices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100
  });
  allPrices.push(...prices.data);
}

console.log(`✅ ${allPrices.length} prix actifs trouvés\n`);

if (dryRun) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🔍 APERÇU DES WEBHOOKS QUI SERONT DÉCLENCHÉS:\n');

  console.log('📡 product.updated:');
  for (const product of veridianProducts) {
    console.log(`   • ${product.name} (${product.id})`);
  }

  console.log('\n💰 price.updated:');
  for (const price of allPrices) {
    const interval = price.recurring?.interval || 'one-time';
    const amount = (price.unit_amount / 100).toFixed(2);
    console.log(`   • ${amount} EUR/${interval} (${price.id})`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n✅ Dry-run terminé');
  console.log('\nPour exécuter réellement, relancez sans --dry-run');
  process.exit(0);
}

// Exécution réelle
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('🚀 DÉCLENCHEMENT DES WEBHOOKS\n');

let successCount = 0;
let errorCount = 0;

// Trigger product.updated pour chaque produit
console.log('📡 Trigger des webhooks product.updated...\n');

for (const product of veridianProducts) {
  try {
    // Faire un update vide pour déclencher le webhook
    await stripe.products.update(product.id, {
      metadata: product.metadata // Pas de changement réel
    });

    console.log(`   ✅ ${product.name} (${product.id})`);
    successCount++;

    // Petit délai pour éviter rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.log(`   ❌ Erreur pour ${product.name}: ${error.message}`);
    errorCount++;
  }
}

console.log('');

// Trigger price.updated pour chaque prix
console.log('💰 Trigger des webhooks price.updated...\n');

for (const price of allPrices) {
  try {
    // Faire un update vide pour déclencher le webhook
    await stripe.prices.update(price.id, {
      metadata: price.metadata // Pas de changement réel
    });

    const interval = price.recurring?.interval || 'one-time';
    const amount = (price.unit_amount / 100).toFixed(2);
    console.log(`   ✅ ${amount} EUR/${interval} (${price.id})`);
    successCount++;

    // Petit délai pour éviter rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    const interval = price.recurring?.interval || 'one-time';
    const amount = (price.unit_amount / 100).toFixed(2);
    console.log(`   ❌ Erreur pour ${amount} EUR/${interval}: ${error.message}`);
    errorCount++;
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('📊 RÉSUMÉ\n');
console.log(`   ✅ Succès: ${successCount}`);
console.log(`   ❌ Erreurs: ${errorCount}`);
console.log(`   📦 Total: ${successCount + errorCount}\n`);

if (errorCount === 0) {
  console.log('✅ Tous les webhooks ont été déclenchés avec succès\n');
  console.log('🔍 VÉRIFICATION TWENTY CRM:\n');
  console.log('   1. Attendez 10-30 secondes que les webhooks soient traités');
  console.log('   2. Vérifiez les logs Twenty: docker logs twenty-server --tail 50 | grep -i billing');
  console.log('   3. Vérifiez la DB Twenty:');
  console.log('      docker compose exec twenty-postgres psql -U twenty -d twenty -c "SELECT id, name FROM core.\\"billingProduct\\";"');
  console.log('      docker compose exec twenty-postgres psql -U twenty -d twenty -c "SELECT COUNT(*) FROM core.\\"billingPrice\\";"');
  console.log('');
} else {
  console.log(`⚠️  ${errorCount} erreurs détectées\n`);
  console.log('Vérifiez les logs ci-dessus pour plus de détails\n');
}
