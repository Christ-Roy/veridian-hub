#!/usr/bin/env node
/**
 * Script de Migration Stripe : TEST → PREPROD/PROD
 *
 * Usage:
 *   # Étape 1 : Exporter depuis TEST
 *   node scripts/dev/migrate-stripe-products.mjs export
 *
 *   # Étape 2 : Importer vers PREPROD (pour test)
 *   STRIPE_SECRET_KEY=sk_test_preprod... node scripts/dev/migrate-stripe-products.mjs import
 *
 *   # Étape 3 : Importer vers PROD (après validation)
 *   STRIPE_SECRET_KEY_LIVE=sk_live_... node scripts/dev/migrate-stripe-products.mjs import --live
 *
 * Sécurité :
 *   - Exporte les produits dans un fichier JSON (stripe-products-export.json)
 *   - Vérifie les doublons avant import
 *   - Dry-run mode disponible (--dry-run)
 */

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

// Configuration
const EXPORT_FILE = './stripe-products-export.json';
const args = process.argv.slice(2);
const command = args[0]; // 'export' or 'import'
const isLiveMode = args.includes('--live');
const isDryRun = args.includes('--dry-run');

// Stripe Keys
const STRIPE_TEST_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_LIVE_KEY = process.env.STRIPE_SECRET_KEY_LIVE;

// Supabase (pour sync DB après import)
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ============================================================================
// Validation
// ============================================================================

function validateEnv() {
  if (command === 'export' && !STRIPE_TEST_KEY) {
    console.error('❌ STRIPE_SECRET_KEY manquant pour l\'export');
    process.exit(1);
  }

  if (command === 'import') {
    const requiredKey = isLiveMode ? STRIPE_LIVE_KEY : STRIPE_TEST_KEY;
    if (!requiredKey) {
      console.error(`❌ ${isLiveMode ? 'STRIPE_SECRET_KEY_LIVE' : 'STRIPE_SECRET_KEY'} manquant pour l'import`);
      process.exit(1);
    }
    if (!existsSync(EXPORT_FILE)) {
      console.error(`❌ Fichier d'export introuvable : ${EXPORT_FILE}`);
      console.log('💡 Lancez d\'abord : node migrate-stripe-products.mjs export');
      process.exit(1);
    }
  }

  if (!['export', 'import'].includes(command)) {
    console.error('❌ Commande invalide. Usage : export | import [--live] [--dry-run]');
    process.exit(1);
  }
}

// ============================================================================
// Export depuis Stripe TEST
// ============================================================================

async function exportProducts() {
  console.log('🚀 Export des produits depuis Stripe TEST...\n');

  const stripe = new Stripe(STRIPE_TEST_KEY, {
    apiVersion: '2024-12-18.acacia',
  });

  // Récupérer tous les produits
  const products = await stripe.products.list({ limit: 100, active: true });
  console.log(`📦 ${products.data.length} produits trouvés`);

  // Récupérer tous les prix
  const prices = await stripe.prices.list({ limit: 100, active: true });
  console.log(`💰 ${prices.data.length} prix trouvés`);

  // Préparer les données pour export
  const exportData = {
    exported_at: new Date().toISOString(),
    source_mode: 'test',
    products: products.data.map(p => ({
      // Données nécessaires pour recréer le produit
      name: p.name,
      description: p.description,
      active: p.active,
      metadata: p.metadata,
      images: p.images,
      // Données de référence (pour mapping)
      original_id: p.id,
      original_created: p.created,
    })),
    prices: prices.data.map(p => ({
      // Données nécessaires pour recréer le prix
      currency: p.currency,
      unit_amount: p.unit_amount,
      recurring: p.recurring,
      type: p.type,
      nickname: p.nickname,
      metadata: p.metadata,
      active: p.active,
      // Référence au produit d'origine
      original_product_id: typeof p.product === 'string' ? p.product : p.product.id,
      original_id: p.id,
      original_created: p.created,
    })),
  };

  // Sauvegarder dans un fichier JSON
  await writeFile(EXPORT_FILE, JSON.stringify(exportData, null, 2));
  console.log(`\n✅ Export réussi : ${EXPORT_FILE}`);
  console.log(`📊 ${exportData.products.length} produits, ${exportData.prices.length} prix exportés`);

  // Afficher un aperçu
  console.log('\n📋 Aperçu des produits exportés :');
  exportData.products.forEach((p, i) => {
    const priceCount = exportData.prices.filter(pr => pr.original_product_id === p.original_id).length;
    console.log(`  ${i + 1}. ${p.name} (${priceCount} prix)`);
  });
}

// ============================================================================
// Import vers Stripe PREPROD/PROD
// ============================================================================

async function importProducts() {
  const targetMode = isLiveMode ? 'LIVE' : 'PREPROD';
  console.log(`🚀 Import des produits vers Stripe ${targetMode}...`);

  if (isDryRun) {
    console.log('⚠️  MODE DRY-RUN : Aucune modification ne sera effectuée\n');
  }

  const stripeKey = isLiveMode ? STRIPE_LIVE_KEY : STRIPE_TEST_KEY;
  const stripe = new Stripe(stripeKey, {
    apiVersion: '2024-12-18.acacia',
  });

  // Charger les données exportées
  const exportData = JSON.parse(await readFile(EXPORT_FILE, 'utf-8'));
  console.log(`📂 Chargé depuis ${EXPORT_FILE}`);
  console.log(`📅 Exporté le : ${exportData.exported_at}`);
  console.log(`📊 ${exportData.products.length} produits, ${exportData.prices.length} prix\n`);

  // Vérifier les doublons
  const existingProducts = await stripe.products.list({ limit: 100 });
  const duplicates = exportData.products.filter(p =>
    existingProducts.data.some(ep => ep.name === p.name)
  );

  if (duplicates.length > 0) {
    console.log('⚠️  Produits existants détectés :');
    duplicates.forEach(p => console.log(`  - ${p.name}`));
    console.log('\n💡 Ces produits seront IGNORÉS pour éviter les doublons.\n');
  }

  // Mapping des anciens IDs vers les nouveaux
  const productIdMap = new Map();
  const priceIdMap = new Map();

  // Créer les produits
  let createdProducts = 0;
  for (const productData of exportData.products) {
    const isDuplicate = existingProducts.data.some(p => p.name === productData.name);

    if (isDuplicate) {
      console.log(`⏭️  Skip (existe déjà) : ${productData.name}`);
      continue;
    }

    if (isDryRun) {
      console.log(`[DRY-RUN] Créerait le produit : ${productData.name}`);
      continue;
    }

    try {
      const newProduct = await stripe.products.create({
        name: productData.name,
        description: productData.description,
        active: productData.active,
        metadata: {
          ...productData.metadata,
          migrated_from: productData.original_id,
          migrated_at: new Date().toISOString(),
        },
        images: productData.images,
      });

      productIdMap.set(productData.original_id, newProduct.id);
      createdProducts++;
      console.log(`✅ Produit créé : ${newProduct.name} (${newProduct.id})`);
    } catch (error) {
      console.error(`❌ Erreur création produit ${productData.name} :`, error.message);
    }
  }

  // Créer les prix
  let createdPrices = 0;
  for (const priceData of exportData.prices) {
    const newProductId = productIdMap.get(priceData.original_product_id);

    if (!newProductId) {
      console.log(`⏭️  Skip prix (produit non créé) : ${priceData.nickname || priceData.original_id}`);
      continue;
    }

    if (isDryRun) {
      console.log(`[DRY-RUN] Créerait le prix : ${priceData.nickname || 'sans nom'} pour produit ${newProductId}`);
      continue;
    }

    try {
      const newPrice = await stripe.prices.create({
        product: newProductId,
        currency: priceData.currency,
        unit_amount: priceData.unit_amount,
        recurring: priceData.recurring,
        nickname: priceData.nickname,
        active: priceData.active,
        metadata: {
          ...priceData.metadata,
          migrated_from: priceData.original_id,
          migrated_at: new Date().toISOString(),
        },
      });

      priceIdMap.set(priceData.original_id, newPrice.id);
      createdPrices++;
      console.log(`  ✅ Prix créé : ${newPrice.nickname || newPrice.id} (${newPrice.unit_amount / 100} ${newPrice.currency})`);
    } catch (error) {
      console.error(`  ❌ Erreur création prix :`, error.message);
    }
  }

  console.log(`\n✅ Import terminé :`);
  console.log(`   📦 ${createdProducts} produits créés`);
  console.log(`   💰 ${createdPrices} prix créés`);

  // Synchroniser avec Supabase DB (si disponible)
  if (!isDryRun && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    console.log(`\n🔄 Synchronisation avec Supabase...`);
    await syncSupabase(stripe);
  }

  // Sauvegarder le mapping pour référence
  if (!isDryRun) {
    const mapping = {
      migrated_at: new Date().toISOString(),
      target_mode: targetMode,
      products: Object.fromEntries(productIdMap),
      prices: Object.fromEntries(priceIdMap),
    };
    await writeFile('./stripe-migration-mapping.json', JSON.stringify(mapping, null, 2));
    console.log(`\n📝 Mapping sauvegardé : stripe-migration-mapping.json`);
  }
}

// ============================================================================
// Synchronisation Supabase
// ============================================================================

async function syncSupabase(stripe) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Clear existing products/prices
  await supabase.from('prices').delete().neq('id', '');
  await supabase.from('products').delete().neq('id', '');

  // Fetch from Stripe
  const products = await stripe.products.list({ limit: 100 });
  const prices = await stripe.prices.list({ limit: 100 });

  // Insert products
  for (const product of products.data) {
    await supabase.from('products').upsert({
      id: product.id,
      active: product.active,
      name: product.name,
      description: product.description || null,
      image: product.images?.[0] || null,
      metadata: product.metadata,
    });
  }

  // Insert prices
  for (const price of prices.data) {
    await supabase.from('prices').upsert({
      id: price.id,
      product_id: typeof price.product === 'string' ? price.product : price.product.id,
      active: price.active,
      currency: price.currency,
      description: price.nickname || null,
      type: price.type,
      unit_amount: price.unit_amount || null,
      interval: price.recurring?.interval || null,
      interval_count: price.recurring?.interval_count || null,
      trial_period_days: price.recurring?.trial_period_days || 0,
      metadata: price.metadata || null,
    });
  }

  console.log(`✅ Supabase synchronisé : ${products.data.length} produits, ${prices.data.length} prix`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  validateEnv();

  if (command === 'export') {
    await exportProducts();
  } else if (command === 'import') {
    await importProducts();
  }
}

main().catch((error) => {
  console.error('❌ Erreur :', error.message);
  console.error(error.stack);
  process.exit(1);
});
