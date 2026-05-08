#!/usr/bin/env node
/**
 * Script d'initialisation Stripe -> hub_app.{products,prices}
 *
 * Post-migration Auth.js / Prisma : insertions directes via `pg` dans le schema
 * `hub_app` (et non plus Supabase).
 *
 * Exécuté automatiquement au démarrage du conteneur. Synchronise les
 * produits/prix seulement si la DB est vide ou si on a changé de mode (TEST/LIVE).
 *
 * FILTRE NAMESPACE :
 * - Ne synchronise QUE les produits avec metadata.namespace = "veridian"
 * - Ignore les produits Twenty metered (WORKFLOW_NODE_EXECUTION)
 * - Ignore les produits archivés sans namespace
 */

import Stripe from 'stripe';
import { withPg } from './lib/db.mjs';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!STRIPE_SECRET_KEY || !DATABASE_URL) {
  console.log('Variables Stripe/DATABASE_URL manquantes - skip sync');
  process.exit(0);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
});

function detectStripeMode() {
  return STRIPE_SECRET_KEY.startsWith('sk_live_');
}

async function checkIfSyncNeeded(client) {
  try {
    const { rows } = await client.query('SELECT id FROM hub_app.products');
    const count = rows.length;

    if (count === 0) return true;

    const isLiveMode = detectStripeMode();
    const firstProductId = rows[0].id;
    const existingIsLive = firstProductId.startsWith('prod_live_') || !firstProductId.startsWith('prod_test_');

    if (existingIsLive !== isLiveMode) {
      console.log(`[Stripe Init] Mode changed (${existingIsLive ? 'LIVE' : 'TEST'} -> ${isLiveMode ? 'LIVE' : 'TEST'}), cleaning old products...`);
      await client.query('DELETE FROM hub_app.prices');
      await client.query('DELETE FROM hub_app.products');
      return true;
    }
    return false;
  } catch (err) {
    console.error('[Stripe Init] DB check failed:', err.message);
    return true;
  }
}

async function syncProducts(client) {
  const products = await stripe.products.list({ limit: 100 });
  let errorCount = 0;
  let syncedCount = 0;

  for (const product of products.data) {
    const isVeridianProduct = product.metadata.namespace === 'veridian' ||
                               (product.metadata.productKey === 'BASE_PRODUCT' && !product.metadata.namespace);
    if (!isVeridianProduct) continue;

    try {
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
          JSON.stringify(product.metadata),
        ],
      );
      syncedCount++;
    } catch (err) {
      console.error(`[Stripe Init] Product sync error (${product.name}):`, err.message);
      errorCount++;
    }
  }

  console.log(`[Stripe Init] Synced ${syncedCount}/${products.data.length} products${errorCount ? ` (${errorCount} errors)` : ''}`);
  return syncedCount;
}

async function syncPrices(client) {
  const prices = await stripe.prices.list({ limit: 100, expand: ['data.product'] });
  let errorCount = 0;
  let syncedCount = 0;

  for (const price of prices.data) {
    const product = price.product;
    if (typeof product === 'object' && product.metadata) {
      const isVeridianProduct = product.metadata.namespace === 'veridian' ||
                                 (product.metadata.productKey === 'BASE_PRODUCT' && !product.metadata.namespace);
      if (!isVeridianProduct) continue;
    }

    try {
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
          price.type, // enum hub_app.PricingType: 'one_time' | 'recurring'
          price.unit_amount || null,
          price.recurring?.interval || null,
          price.recurring?.interval_count || null,
          price.recurring?.trial_period_days || 0,
          JSON.stringify(price.metadata || {}),
        ],
      );
      syncedCount++;
    } catch (err) {
      console.error(`[Stripe Init] Price sync error (${price.id}):`, err.message);
      errorCount++;
    }
  }

  console.log(`[Stripe Init] Synced ${syncedCount}/${prices.data.length} prices${errorCount ? ` (${errorCount} errors)` : ''}`);
  return syncedCount;
}

async function main() {
  await withPg(async (client) => {
    const needsSync = await checkIfSyncNeeded(client);
    if (!needsSync) {
      console.log('[Stripe Init] Products already synced - skipping');
      return;
    }
    console.log('[Stripe Init] Starting sync...');
    const productsCount = await syncProducts(client);
    const pricesCount = await syncPrices(client);
    console.log(`[Stripe Init] Sync complete: ${productsCount} products, ${pricesCount} prices`);
  });
}

main().catch((error) => {
  console.error('Erreur init Stripe:', error.message);
  process.exit(0);
});
