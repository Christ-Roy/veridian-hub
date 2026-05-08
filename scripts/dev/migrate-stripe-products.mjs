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
import { withPg } from '../lib/db.mjs';
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

// Postgres direct (pour sync DB hub_app.* après import)
const DATABASE_URL = process.env.DATABASE_URL;

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
// Synchronisation hub_app (Postgres direct)
// ============================================================================

async function syncSupabase(stripe) {
  if (!DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL non défini, skip sync DB');
    return;
  }

  await withPg(async (client) => {
    // Clear existing products/prices (cascade délègue rien — on TRUNCATE-like)
    await client.query('DELETE FROM hub_app.prices');
    await client.query('DELETE FROM hub_app.products');

    const products = await stripe.products.list({ limit: 100 });
    const prices = await stripe.prices.list({ limit: 100 });

    for (const product of products.data) {
      await client.query(
        `INSERT INTO hub_app.products (id, active, name, description, image, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           active = EXCLUDED.active,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           image = EXCLUDED.image,
           metadata = EXCLUDED.metadata`,
        [
          product.id,
          product.active,
          product.name,
          product.description || null,
          product.images?.[0] || null,
          JSON.stringify(product.metadata ?? {}),
        ],
      );
    }

    for (const price of prices.data) {
      await client.query(
        `INSERT INTO hub_app.prices (
           id, product_id, active, currency, description, type,
           unit_amount, interval, interval_count, trial_period_days, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           product_id = EXCLUDED.product_id,
           active = EXCLUDED.active,
           currency = EXCLUDED.currency,
           description = EXCLUDED.description,
           type = EXCLUDED.type,
           unit_amount = EXCLUDED.unit_amount,
           interval = EXCLUDED.interval,
           interval_count = EXCLUDED.interval_count,
           trial_period_days = EXCLUDED.trial_period_days,
           metadata = EXCLUDED.metadata`,
        [
          price.id,
          typeof price.product === 'string' ? price.product : price.product.id,
          price.active,
          price.currency,
          price.nickname || null,
          price.type,
          price.unit_amount || null,
          price.recurring?.interval || null,
          price.recurring?.interval_count || null,
          price.recurring?.trial_period_days || 0,
          JSON.stringify(price.metadata ?? {}),
        ],
      );
    }

    console.log(`✅ DB synchronisée : ${products.data.length} produits, ${prices.data.length} prix`);
  });
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
