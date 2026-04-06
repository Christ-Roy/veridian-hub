#!/usr/bin/env node
/**
 * Script d'initialisation Stripe → Supabase
 * Exécuté automatiquement au démarrage du conteneur
 * Synchronise les produits/prix seulement si la DB est vide
 *
 * FILTRE NAMESPACE:
 * - Ne synchronise QUE les produits avec metadata.namespace = "veridian"
 * - Ignore les produits Twenty metered (WORKFLOW_NODE_EXECUTION)
 * - Ignore les produits archivés sans namespace
 *
 * Compatible avec le nouveau système "Billing as Code" (config/billing.config.ts)
 */

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Use LIVE key in production, fallback to test key
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
// Use internal Docker URL if available (for server-side), fallback to public URL
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Vérifier les variables requises
if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log('⚠️  Variables Stripe/Supabase manquantes - skip sync');
  process.exit(0); // Exit sans erreur
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function detectStripeMode() {
  // Detect if we're using LIVE keys by checking the key prefix
  const isLiveMode = STRIPE_SECRET_KEY.startsWith('sk_live_');
  return isLiveMode;
}

async function checkIfSyncNeeded() {
  const { count, error, data } = await supabase
    .from('products')
    .select('id', { count: 'exact' });

  if (error) {
    console.error('❌ Erreur check Supabase:', error.message);
    return true; // Sync par défaut en cas d'erreur
  }

  // If no products, sync is needed
  if (count === 0) {
    return true;
  }

  // Check if existing products match current Stripe mode
  const isLiveMode = await detectStripeMode();
  const existingProducts = data || [];

  if (existingProducts.length > 0) {
    const firstProductId = existingProducts[0].id;
    const existingIsLive = firstProductId.startsWith('prod_live_') ||
                           !firstProductId.startsWith('prod_test_');

    // If mode changed (TEST → LIVE or LIVE → TEST), need to clean and resync
    if (existingIsLive !== isLiveMode) {
      console.log(`[Stripe Init] Mode changed (${existingIsLive ? 'LIVE' : 'TEST'} → ${isLiveMode ? 'LIVE' : 'TEST'}), cleaning old products...`);
      await supabase.from('prices').delete().neq('id', '');
      await supabase.from('products').delete().neq('id', '');
      return true;
    }
  }

  return false; // Products exist and match current mode
}

async function syncProducts() {
  const products = await stripe.products.list({ limit: 100 });
  let errorCount = 0;
  let syncedCount = 0;

  for (const product of products.data) {
    // FILTRE : Ne synchroniser que les produits Veridian (namespace = "veridian")
    // OU les produits BASE_PRODUCT sans namespace (compatibilité ancienne version)
    const isVeridianProduct = product.metadata.namespace === 'veridian' ||
                               (product.metadata.productKey === 'BASE_PRODUCT' && !product.metadata.namespace);

    if (!isVeridianProduct) {
      // Skip les produits Twenty metered, produits archivés, etc.
      continue;
    }

    const { error } = await supabase.from('products').upsert({
      id: product.id,
      active: product.active,
      name: product.name,
      description: product.description || null,
      image: product.images?.[0] || null,
      metadata: product.metadata,
    });

    if (error) {
      console.error(`[Stripe Init] Product sync error (${product.name}):`, error.message);
      errorCount++;
    } else {
      syncedCount++;
    }
  }

  if (errorCount === 0) {
    console.log(`[Stripe Init] Synced ${syncedCount}/${products.data.length} products (filtered by namespace)`);
  } else {
    console.log(`[Stripe Init] Synced ${syncedCount}/${products.data.length} products with ${errorCount} errors`);
  }

  return syncedCount;
}

async function syncPrices() {
  const prices = await stripe.prices.list({ limit: 100, expand: ['data.product'] });
  let errorCount = 0;
  let syncedCount = 0;

  for (const price of prices.data) {
    // Récupérer le produit (expand dans la requête list)
    const product = price.product;

    // FILTRE : Ne synchroniser que les prix des produits Veridian
    if (typeof product === 'object' && product.metadata) {
      const isVeridianProduct = product.metadata.namespace === 'veridian' ||
                                 (product.metadata.productKey === 'BASE_PRODUCT' && !product.metadata.namespace);

      if (!isVeridianProduct) {
        // Skip les prix Twenty metered, etc.
        continue;
      }
    }

    const { error } = await supabase.from('prices').upsert({
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

    if (error) {
      console.error(`[Stripe Init] Price sync error (${price.id}):`, error.message);
      errorCount++;
    } else {
      syncedCount++;
    }
  }

  if (errorCount === 0) {
    console.log(`[Stripe Init] Synced ${syncedCount}/${prices.data.length} prices (filtered by namespace)`);
  } else {
    console.log(`[Stripe Init] Synced ${syncedCount}/${prices.data.length} prices with ${errorCount} errors`);
  }

  return syncedCount;
}

async function main() {
  const needsSync = await checkIfSyncNeeded();

  if (!needsSync) {
    console.log('[Stripe Init] Products already synced - skipping');
    return;
  }

  console.log('[Stripe Init] Starting sync...');

  const productsCount = await syncProducts();
  const pricesCount = await syncPrices();

  console.log(`[Stripe Init] Sync complete: ${productsCount} products, ${pricesCount} prices`);
}

main().catch((error) => {
  console.error('❌ Erreur init Stripe:', error.message);
  process.exit(0); // Ne pas bloquer le démarrage du conteneur
});
