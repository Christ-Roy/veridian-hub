#!/usr/bin/env node

/**
 * Script de recréation des produits Stripe pour synchronisation Twenty
 *
 * CONTEXTE:
 * - Le webhook Twenty a été créé APRÈS les produits Stripe
 * - Cette option ARCHIVE les produits existants et les RECRÉE avec nouvelles identités
 * - Déclenche naturellement les webhooks product.created et price.created
 *
 * ⚠️ ATTENTION:
 * - NE PAS utiliser si des abonnements actifs existent
 * - Les produits existants seront archivés (active: false) pas supprimés
 * - Les lookup_keys seront préservées pour rollback si besoin
 *
 * USAGE:
 *   node scripts/billing/recreate-products-for-twenty.mjs --env=prod --dry-run
 *   node scripts/billing/recreate-products-for-twenty.mjs --env=prod --confirm
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
const confirm = args.includes('--confirm');

if (!dryRun && !confirm) {
  console.error('\n❌ ERREUR: Ce script nécessite --dry-run ou --confirm\n');
  console.log('Usage:');
  console.log('  --dry-run  : Simuler sans modifier');
  console.log('  --confirm  : Exécuter réellement (⚠️  dangereux)\n');
  process.exit(1);
}

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

// Charger la config billing
console.log('📚 Chargement de la configuration billing...\n');

const configPath = path.join(__dirname, '../../config/billing.config.ts');
// Utiliser export-config.mjs pour convertir TypeScript → JSON
import { execSync } from 'child_process';
const exportScript = path.join(__dirname, 'export-config.mjs');
execSync(`node ${exportScript}`, { stdio: 'ignore' });

const billingConfigPath = path.join(__dirname, '.billing-config.json');
const billingConfig = JSON.parse(fs.readFileSync(billingConfigPath, 'utf-8'));

console.log(`✅ ${billingConfig.plans.length} plans chargés depuis billing.config.ts\n`);

// Récupérer les produits existants
console.log('📦 Récupération des produits Stripe existants...\n');

const products = await stripe.products.list({ limit: 100 });
const veridianProducts = products.data.filter(p =>
  p.metadata?.namespace === 'veridian' &&
  p.metadata?.productKey === 'BASE_PRODUCT'
);

if (veridianProducts.length === 0) {
  console.log('⚠️  Aucun produit Veridian trouvé\n');
  console.log('Rien à archiver, création directe des nouveaux produits\n');
}

console.log(`✅ ${veridianProducts.length} produits Veridian existants:\n`);

for (const product of veridianProducts) {
  console.log(`   📦 ${product.name} (${product.id})`);
  console.log(`      Plan: ${product.metadata.planKey}`);

  // Vérifier les abonnements actifs
  const subscriptions = await stripe.subscriptions.list({
    limit: 100,
    status: 'active'
  });

  const activeSubsForProduct = subscriptions.data.filter(sub =>
    sub.items.data.some(item => item.price.product === product.id)
  );

  if (activeSubsForProduct.length > 0) {
    console.log(`      ⚠️  ${activeSubsForProduct.length} abonnements actifs détectés`);
  }

  console.log('');
}

// Vérifier les abonnements actifs globaux
console.log('🔍 Vérification des abonnements actifs...\n');

const allSubscriptions = await stripe.subscriptions.list({
  limit: 100,
  status: 'active'
});

if (allSubscriptions.data.length > 0) {
  console.error('❌ ERREUR: Des abonnements actifs existent!\n');
  console.log('Abonnements actifs:');
  for (const sub of allSubscriptions.data) {
    console.log(`   • ${sub.id} - Customer: ${sub.customer}`);
  }
  console.log('\n⚠️  Ce script ne peut être utilisé que si AUCUN abonnement n\'existe\n');
  process.exit(1);
}

console.log('✅ Aucun abonnement actif - Opération sûre\n');

if (dryRun) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🔍 APERÇU DES OPÉRATIONS:\n');

  console.log('1️⃣  ARCHIVAGE (active: false):');
  for (const product of veridianProducts) {
    console.log(`   📦 ${product.name} (${product.id})`);

    const prices = await stripe.prices.list({ product: product.id, limit: 100 });
    for (const price of prices.data) {
      const interval = price.recurring?.interval || 'one-time';
      const amount = (price.unit_amount / 100).toFixed(2);
      console.log(`      💰 ${amount} EUR/${interval} (${price.id})`);
    }
  }

  console.log('\n2️⃣  CRÉATION DE NOUVEAUX PRODUITS:');
  for (const plan of billingConfig.plans) {
    console.log(`   📦 ${plan.name} (nouveau produit)`);
    console.log(`      Metadata: planKey=${plan.stripe_metadata.planKey}`);

    for (const price of plan.prices) {
      if (price.active) {
        const amount = (price.amount / 100).toFixed(2);
        console.log(`      💰 ${amount} EUR/${price.interval} (lookup_key: ${price.lookup_key})`);
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n✅ Dry-run terminé');
  console.log('\n⚠️  Pour exécuter réellement, utilisez --confirm (DANGER)');
  process.exit(0);
}

// Exécution réelle avec --confirm
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('🚀 EXÉCUTION RÉELLE\n');

let archivedCount = 0;
let createdProducts = 0;
let createdPrices = 0;

// Étape 1: Archiver les produits existants
console.log('1️⃣  Archivage des produits existants...\n');

for (const product of veridianProducts) {
  try {
    await stripe.products.update(product.id, {
      active: false,
      metadata: {
        ...product.metadata,
        archived_at: new Date().toISOString(),
        archived_reason: 'Recréation pour sync Twenty CRM'
      }
    });

    console.log(`   ✅ Archivé: ${product.name} (${product.id})`);
    archivedCount++;
  } catch (error) {
    console.log(`   ❌ Erreur archivage ${product.name}: ${error.message}`);
  }
}

console.log(`\n   Total archivé: ${archivedCount}\n`);

// Étape 2: Créer les nouveaux produits
console.log('2️⃣  Création des nouveaux produits...\n');

for (const plan of billingConfig.plans) {
  try {
    // Créer le produit
    const newProduct = await stripe.products.create({
      name: plan.name,
      description: plan.description,
      metadata: {
        ...plan.stripe_metadata,
        namespace: 'veridian',
        internal_id: plan.internal_id,
        // UI metadata en JSON
        ui_metadata: JSON.stringify(plan.ui_metadata)
      },
      active: plan.active
    });

    console.log(`   ✅ Créé: ${plan.name} (${newProduct.id})`);
    createdProducts++;

    // Créer les prix
    for (const priceConfig of plan.prices) {
      if (!priceConfig.active) continue;

      const newPrice = await stripe.prices.create({
        product: newProduct.id,
        currency: priceConfig.currency,
        unit_amount: priceConfig.amount,
        recurring: {
          interval: priceConfig.interval,
          interval_count: priceConfig.interval_count || 1
        },
        lookup_key: priceConfig.lookup_key,
        tax_behavior: priceConfig.tax_behavior || 'unspecified',
        active: priceConfig.active,
        metadata: {
          lookup_key: priceConfig.lookup_key
        }
      });

      const amount = (priceConfig.amount / 100).toFixed(2);
      console.log(`      💰 ${amount} EUR/${priceConfig.interval} (${newPrice.id})`);
      createdPrices++;

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.log(`   ❌ Erreur création ${plan.name}: ${error.message}`);
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('📊 RÉSUMÉ\n');
console.log(`   📦 Produits archivés: ${archivedCount}`);
console.log(`   ✨ Nouveaux produits créés: ${createdProducts}`);
console.log(`   💰 Nouveaux prix créés: ${createdPrices}\n`);

console.log('✅ Opération terminée\n');
console.log('🔍 VÉRIFICATIONS:\n');
console.log('   1. Stripe Dashboard → Produits (vérifier les nouveaux)');
console.log('   2. Attendez 10-30 secondes pour les webhooks');
console.log('   3. Vérifiez Twenty DB:');
console.log('      docker compose exec twenty-postgres psql -U twenty -d twenty -c "SELECT id, name FROM core.\\"billingProduct\\";"');
console.log('   4. Vérifiez Dashboard Supabase:');
console.log('      docker compose exec supabase-db psql -U postgres -d postgres -c "SELECT id, name FROM products;"');
console.log('');
console.log('⚠️  IMPORTANT: Lancez ensuite le script de sync pour Supabase:');
console.log('   node scripts/billing/sync-billing-to-stripe.mjs --env=prod');
console.log('');
