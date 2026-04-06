#!/usr/bin/env node

/**
 * SCRIPT DE SYNCHRONISATION BILLING AS CODE → STRIPE
 *
 * Ce script est idempotent et safe pour la production.
 * Il synchronise la configuration billing.config.ts vers Stripe.
 *
 * RÈGLES:
 * - Additive only: Jamais de suppression de produits/prix
 * - Idempotence: Via lookup_keys et metadata.internal_id
 * - Namespace: Ignore les produits n'appartenant pas à Veridian
 * - Grandfathering: Les prix désactivés restent en Stripe pour les abonnés existants
 *
 * Usage:
 *   node scripts/sync-billing-to-stripe.mjs [--env=dev|preprod|prod] [--dry-run]
 *
 * Options:
 *   --env=ENV       Environnement Stripe (dev, preprod, prod). Défaut: dev
 *   --dry-run       Mode simulation (aucune modification réelle)
 *   --force         Force la mise à jour même si pas de changements
 */

import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const forceUpdate = args.includes('--force');
const envArg = args.find(arg => arg.startsWith('--env='))?.split('=')[1] || 'dev';

// Charger les variables d'environnement depuis infra/.env ou process.env
const envPath = path.join(__dirname, '../../../infra/.env');
let envVars = {};

// Tenter de charger depuis le fichier .env, sinon utiliser process.env
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');

  // Premier passage : charger toutes les variables
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) {
      envVars[match[1]] = match[2];
    }
  });

  // Deuxième passage : résoudre les variables imbriquées (${VAR})
  Object.keys(envVars).forEach(key => {
    let value = envVars[key];
    const matches = value.matchAll(/\$\{([A-Z_]+)\}/g);
    for (const match of matches) {
      const varName = match[1];
      if (envVars[varName]) {
        value = value.replace(match[0], envVars[varName]);
      }
    }
    envVars[key] = value;
  });
} else {
  // Fallback : utiliser process.env (quand exécuté dans Docker)
  console.log('⚠️  Fichier .env non trouvé, utilisation de process.env');
  envVars = process.env;
}

// Sélectionner la clé Stripe selon l'environnement
let stripeSecretKey;
let envLabel;

switch (envArg) {
  case 'preprod':
    stripeSecretKey = envVars.STRIPE_SECRET_KEY_PREPROD;
    envLabel = 'PREPROD';
    break;
  case 'prod':
    stripeSecretKey = envVars.STRIPE_SECRET_KEY_LIVE;
    envLabel = 'PRODUCTION';
    break;
  default:
    stripeSecretKey = envVars.STRIPE_SECRET_KEY;
    envLabel = 'DEV';
}

if (!stripeSecretKey) {
  console.error(`❌ Clé Stripe non trouvée pour l'environnement: ${envArg}`);
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-12-18.acacia'
});

// Initialiser Supabase Admin pour la synchronisation
// Utiliser l'URL interne Docker si disponible, sinon l'URL publique
const supabaseUrl = envVars.SUPABASE_URL || 'http://supabase-kong:8000';
const supabaseKey = envVars.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Variables Supabase manquantes (SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Charger la configuration billing
const billingConfigPath = path.join(__dirname, '../../config/billing.config.ts');

// Note: On doit utiliser un import dynamique pour TypeScript
// En attendant, on va parser manuellement le fichier
// TODO: Utiliser ts-node ou compiler le fichier avant

console.log('═══════════════════════════════════════════════════════════');
console.log('🚀 SYNCHRONISATION BILLING → STRIPE');
console.log('═══════════════════════════════════════════════════════════\n');
console.log(`📍 Environnement: ${envLabel}`);
console.log(`🔑 Mode Stripe: ${stripeSecretKey.startsWith('sk_live_') ? 'LIVE' : 'TEST'}`);
console.log(`🔄 Mode: ${isDryRun ? '🔍 DRY-RUN (simulation)' : '✅ EXÉCUTION RÉELLE'}`);
console.log(`⚡ Force: ${forceUpdate ? 'OUI' : 'NON'}\n`);

if (envLabel === 'PRODUCTION' && !isDryRun) {
  console.log('⚠️  ATTENTION: Vous allez modifier la PRODUCTION !');
  console.log('   Appuyez sur Ctrl+C pour annuler...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));
}

// ============================================================================
// CONFIGURATION BILLING (Importée depuis billing.config.ts)
// ============================================================================

// Exporter la config TypeScript en JSON
console.log('📦 Export de la configuration billing...');
import { execSync } from 'child_process';
const configJsonPath = path.join(__dirname, '.billing-config.json');

try {
  execSync('node ' + path.join(__dirname, 'export-config.mjs'), { stdio: 'pipe' });
} catch (error) {
  console.error('❌ Erreur lors de l\'export de la config:', error.message);
  process.exit(1);
}

const billingConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
const BILLING_NAMESPACE = billingConfig.namespace;
const PAID_PLANS = billingConfig.plans;
const METERED_PRODUCTS = billingConfig.metered || [];
const WORKFLOW_METER_ID = billingConfig.meterId;

console.log(`✅ ${PAID_PLANS.length} plans + ${METERED_PRODUCTS.length} metered products chargés depuis billing.config.ts\n`);

/*
// Ancienne config hardcodée - supprimée au profit de l'import dynamique
const PAID_PLANS_OLD = [
// ... config hardcodée supprimée ...
];
*/

// ============================================================================
// HELPERS
// ============================================================================

function log(icon, message, indent = 0) {
  const padding = '  '.repeat(indent);
  console.log(`${padding}${icon} ${message}`);
}

function logDiff(field, oldValue, newValue) {
  if (oldValue !== newValue) {
    log('  📝', `${field}: "${oldValue}" → "${newValue}"`, 2);
    return true;
  }
  return false;
}

// ============================================================================
// SYNCHRONISATION SUPABASE
// ============================================================================

/**
 * Synchronise un produit Stripe vers Supabase
 */
async function syncProductToSupabase(stripeProduct) {
  if (isDryRun) return;

  const productData = {
    id: stripeProduct.id,
    active: stripeProduct.active,
    name: stripeProduct.name,
    description: stripeProduct.description ?? null,
    image: stripeProduct.images?.[0] ?? null,
    metadata: stripeProduct.metadata
  };

  const { error } = await supabase
    .from('products')
    .upsert([productData]);

  if (error) {
    console.error(`  ⚠️  Erreur sync Supabase produit ${stripeProduct.id}:`, error.message);
  } else {
    log('  💾', `Produit synchronisé vers Supabase`, 2);
  }
}

/**
 * Synchronise un prix Stripe vers Supabase
 */
async function syncPriceToSupabase(stripePrice) {
  if (isDryRun) return;

  const priceData = {
    id: stripePrice.id,
    product_id: typeof stripePrice.product === 'string' ? stripePrice.product : '',
    active: stripePrice.active,
    currency: stripePrice.currency,
    description: stripePrice.nickname ?? null,
    type: stripePrice.type,
    unit_amount: stripePrice.unit_amount ?? null,
    interval: stripePrice.recurring?.interval ?? null,
    interval_count: stripePrice.recurring?.interval_count ?? null,
    trial_period_days: stripePrice.recurring?.trial_period_days ?? null,
    metadata: stripePrice.metadata ?? null
  };

  const { error } = await supabase
    .from('prices')
    .upsert([priceData]);

  if (error) {
    console.error(`  ⚠️  Erreur sync Supabase prix ${stripePrice.id}:`, error.message);
  } else {
    log('  💾', `Prix synchronisé vers Supabase`, 2);
  }
}

// ============================================================================
// RÉCUPÉRATION DES DONNÉES STRIPE
// ============================================================================

async function fetchStripeProducts() {
  log('📦', 'Récupération des produits Stripe...');

  const products = await stripe.products.list({
    limit: 100,
    active: true
  });

  // Filtrer uniquement les produits Veridian (BASE_PRODUCT + WORKFLOW_NODE_EXECUTION)
  const veridianProducts = products.data.filter(p =>
    p.metadata.namespace === BILLING_NAMESPACE ||
    (p.metadata.productKey && !p.metadata.namespace) // Ancien format (BASE_PRODUCT ou WORKFLOW_NODE_EXECUTION)
  );

  log('✅', `${veridianProducts.length} produits Veridian trouvés sur ${products.data.length} total`, 1);

  // Récupérer les prix pour chaque produit
  const productsWithPrices = await Promise.all(
    veridianProducts.map(async product => {
      const prices = await stripe.prices.list({
        product: product.id,
        limit: 100
      });

      return {
        ...product,
        prices: prices.data
      };
    })
  );

  return productsWithPrices;
}

// ============================================================================
// SYNCHRONISATION DES PRODUITS
// ============================================================================

async function syncProducts() {
  const stripeProducts = await fetchStripeProducts();

  log('🔄', `Synchronisation de ${PAID_PLANS.length} plans...`);

  const stats = {
    created: 0,
    updated: 0,
    skipped: 0,
    pricesCreated: 0,
    pricesUpdated: 0
  };

  for (const plan of PAID_PLANS) {
    log('📋', `Plan: ${plan.name} (${plan.internal_id})`, 1);

    // Chercher le produit existant via internal_id (nouveau) ou planKey (ancien format)
    const existingProduct = stripeProducts.find(p =>
      p.metadata.internal_id === plan.internal_id ||
      (p.metadata.planKey === plan.stripe_metadata.planKey && p.metadata.productKey === 'BASE_PRODUCT')
    );

    let product;
    let hasChanges = false;

    if (!existingProduct) {
      log('➕', 'Nouveau produit détecté', 2);

      if (!isDryRun) {
        product = await stripe.products.create({
          name: plan.name,
          description: plan.description,
          metadata: {
            namespace: BILLING_NAMESPACE,
            internal_id: plan.internal_id,
            ...plan.stripe_metadata,
            // Métadonnées UI (pour le frontend)
            ui_display_order: plan.ui_metadata.display_order.toString(),
            ui_badge: plan.ui_metadata.badge || '',
            ui_highlighted: plan.ui_metadata.highlighted ? 'true' : 'false',
            ui_cta_text: plan.ui_metadata.cta_text,
            ui_features: JSON.stringify(plan.ui_metadata.features)
          },
          active: plan.active
        });

        log('✅', `Produit créé: ${product.id}`, 2);
        stats.created++;

        // Synchroniser vers Supabase
        await syncProductToSupabase(product);

        // Initialiser prices à un tableau vide pour les nouveaux produits
        product.prices = [];
      } else {
        log('🔍', '[DRY-RUN] Produit serait créé', 2);
        // En dry-run, on skip la sync des prix
        continue;
      }
    } else {
      product = existingProduct;
      log('🔍', `Produit existant trouvé: ${product.id}`, 2);

      // Vérifier si le produit existe dans Supabase
      const { data: existingDbProduct, error: checkError } = await supabase
        .from('products')
        .select('id')
        .eq('id', product.id)
        .maybeSingle();

      const needsSync = !existingDbProduct;

      // Vérifier les changements
      hasChanges = false;
      hasChanges |= logDiff('name', product.name, plan.name);
      hasChanges |= logDiff('description', product.description, plan.description);
      hasChanges |= logDiff('active', product.active, plan.active);

      // Vérifier les metadata
      const metadataToUpdate = {
        namespace: BILLING_NAMESPACE,
        internal_id: plan.internal_id,
        ...plan.stripe_metadata,
        ui_display_order: plan.ui_metadata.display_order.toString(),
        ui_badge: plan.ui_metadata.badge || '',
        ui_highlighted: plan.ui_metadata.highlighted ? 'true' : 'false',
        ui_cta_text: plan.ui_metadata.cta_text,
        ui_features: JSON.stringify(plan.ui_metadata.features)
      };

      for (const [key, value] of Object.entries(metadataToUpdate)) {
        if (product.metadata[key] !== value) {
          log('  📝', `metadata.${key}: "${product.metadata[key]}" → "${value}"`, 2);
          hasChanges = true;
        }
      }

      if (hasChanges || forceUpdate || needsSync) {
        if (!isDryRun) {
          const updatedProduct = await stripe.products.update(product.id, {
            name: plan.name,
            description: plan.description,
            metadata: metadataToUpdate,
            active: plan.active
          });

          if (hasChanges || forceUpdate) {
            log('✅', 'Produit mis à jour', 2);
            stats.updated++;
          } else if (needsSync) {
            log('💾', 'Produit synchronisé vers Supabase (pas de changements Stripe)', 2);
          }

          // Synchroniser vers Supabase (toujours, car needsSync peut être true)
          await syncProductToSupabase(updatedProduct);

          // IMPORTANT: Préserver les prix car l'objet retourné par update() ne les inclut pas
          product = { ...updatedProduct, prices: product.prices };
        } else {
          log('🔍', '[DRY-RUN] Produit serait mis à jour', 2);
        }
      } else {
        log('⏭️ ', 'Pas de changements', 2);
        stats.skipped++;
      }
    }

    // Synchroniser les prix
    await syncPrices(product, plan, stats);

    console.log('');
  }

  // Afficher le résumé
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ DE LA SYNCHRONISATION');
  console.log('═══════════════════════════════════════════════════════════\n');
  log('➕', `Produits créés: ${stats.created}`);
  log('🔄', `Produits mis à jour: ${stats.updated}`);
  log('⏭️ ', `Produits inchangés: ${stats.skipped}`);
  log('💰', `Prix créés: ${stats.pricesCreated}`);
  log('🔄', `Prix mis à jour: ${stats.pricesUpdated}`);
  console.log('');

  if (isDryRun) {
    log('ℹ️ ', 'Mode DRY-RUN: Aucune modification réelle effectuée');
  } else {
    log('✅', 'Synchronisation terminée avec succès');
  }
}

// ============================================================================
// SYNCHRONISATION DES PRIX
// ============================================================================

async function syncPrices(product, plan, stats) {
  log('💰', `Synchronisation de ${plan.prices.length} prix...`, 2);

  for (const priceConfig of plan.prices) {
    // DEBUG: Afficher les prix du produit
    if (process.env.DEBUG) {
      console.log(`  [DEBUG] Prix dans le produit:`, product.prices?.map(p => ({
        id: p.id,
        lookup_key: p.lookup_key,
        amount: p.unit_amount,
        interval: p.recurring?.interval
      })));
    }

    // Chercher le prix existant UNIQUEMENT via lookup_key
    // Note: On ne match plus par montant+intervalle car les lookup_keys sont immuables
    // Pour créer une nouvelle version (v2, v3, etc.), il faut créer un nouveau prix
    let existingPrice = product.prices?.find(p => {
      return p.lookup_key && p.lookup_key === priceConfig.lookup_key;
    });

    if (!existingPrice) {
      log('➕', `Nouveau prix: ${priceConfig.lookup_key}`, 3);

      if (!isDryRun) {
        const price = await stripe.prices.create({
          product: product.id,
          currency: priceConfig.currency,
          unit_amount: priceConfig.amount,
          recurring: {
            interval: priceConfig.interval,
            interval_count: priceConfig.interval_count || 1,
            trial_period_days: priceConfig.trial_period_days || undefined
          },
          lookup_key: priceConfig.lookup_key,
          active: priceConfig.active,
          tax_behavior: priceConfig.tax_behavior,
          nickname: priceConfig.nickname,
          metadata: {
            namespace: BILLING_NAMESPACE,
            synced: 'true'
          }
        });

        log('✅', `Prix créé: ${price.id} (${priceConfig.amount / 100}€/${priceConfig.interval})`, 3);
        stats.pricesCreated++;

        // Synchroniser vers Supabase
        await syncPriceToSupabase(price);
      } else {
        log('🔍', `[DRY-RUN] Prix serait créé: ${priceConfig.amount / 100}€/${priceConfig.interval}`, 3);
      }
    } else {
      log('🔍', `Prix existant: ${existingPrice.id}`, 3);

      // Vérifier si le prix a besoin de mises à jour
      const needsUpdate = {
        active: existingPrice.active !== priceConfig.active,
        lookup_key: !existingPrice.lookup_key || existingPrice.lookup_key !== priceConfig.lookup_key,
        metadata: existingPrice.metadata?.namespace !== BILLING_NAMESPACE
      };

      const hasChanges = Object.values(needsUpdate).some(v => v);

      if (hasChanges) {
        if (needsUpdate.active) {
          log('  📝', `active: ${existingPrice.active} → ${priceConfig.active}`, 3);
        }
        if (needsUpdate.lookup_key) {
          log('  📝', `lookup_key: "${existingPrice.lookup_key || 'AUCUNE'}" → "${priceConfig.lookup_key}"`, 3);
        }
        if (needsUpdate.metadata) {
          log('  📝', `metadata: Ajout du namespace`, 3);
        }

        if (!isDryRun) {
          const updateData = {
            active: priceConfig.active,
            metadata: {
              namespace: BILLING_NAMESPACE,
              synced: 'true',
              ...(existingPrice.metadata || {})
            }
          };

          // Ajouter la lookup_key seulement si elle n'existe pas
          if (!existingPrice.lookup_key) {
            updateData.lookup_key = priceConfig.lookup_key;
          }

          const updatedPrice = await stripe.prices.update(existingPrice.id, updateData);

          log('✅', 'Prix mis à jour', 3);
          stats.pricesUpdated++;

          // Synchroniser vers Supabase
          await syncPriceToSupabase(updatedPrice);
        } else {
          log('🔍', '[DRY-RUN] Prix serait mis à jour', 3);
        }
      } else {
        log('⏭️ ', 'Prix inchangé', 3);

        // Même si le prix est inchangé dans Stripe, s'assurer qu'il est dans Supabase
        if (!isDryRun) {
          await syncPriceToSupabase(existingPrice);
        }
      }
    }
  }
}

// ============================================================================
// SYNCHRONISATION DES PRODUITS METERED (WORKFLOW_NODE_EXECUTION)
// ============================================================================

async function syncMeteredProducts() {
  if (METERED_PRODUCTS.length === 0) {
    log('ℹ️ ', 'Aucun produit metered à synchroniser');
    return;
  }

  const stripeProducts = await fetchStripeProducts();

  log('🔄', `Synchronisation de ${METERED_PRODUCTS.length} produits metered...`);

  const stats = {
    created: 0,
    updated: 0,
    skipped: 0,
    pricesCreated: 0,
  };

  for (const meteredProduct of METERED_PRODUCTS) {
    log('📋', `Metered: ${meteredProduct.name} (${meteredProduct.internal_id})`, 1);

    // Chercher le produit existant
    const existingProduct = stripeProducts.find(p =>
      p.metadata.internal_id === meteredProduct.internal_id ||
      (p.metadata.planKey === meteredProduct.stripe_metadata.planKey &&
       p.metadata.productKey === 'WORKFLOW_NODE_EXECUTION')
    );

    const metadataToSet = {
      namespace: BILLING_NAMESPACE,
      internal_id: meteredProduct.internal_id,
      ...meteredProduct.stripe_metadata,
    };

    let product;

    if (!existingProduct) {
      log('➕', 'Nouveau produit metered détecté', 2);

      if (!isDryRun) {
        product = await stripe.products.create({
          name: meteredProduct.name,
          description: meteredProduct.description,
          metadata: metadataToSet,
          active: meteredProduct.active,
        });

        log('✅', `Produit créé: ${product.id}`, 2);
        stats.created++;

        await syncProductToSupabase(product);
        product.prices = [];
      } else {
        log('🔍', '[DRY-RUN] Produit serait créé', 2);
        continue;
      }
    } else {
      product = existingProduct;
      log('🔍', `Produit existant trouvé: ${product.id}`, 2);

      // Vérifier changements metadata
      let hasChanges = false;
      for (const [key, value] of Object.entries(metadataToSet)) {
        if (product.metadata[key] !== value) {
          log('  📝', `metadata.${key}: "${product.metadata[key]}" → "${value}"`, 2);
          hasChanges = true;
        }
      }

      if (hasChanges || forceUpdate) {
        if (!isDryRun) {
          const updatedProduct = await stripe.products.update(product.id, {
            name: meteredProduct.name,
            description: meteredProduct.description,
            metadata: metadataToSet,
            active: meteredProduct.active,
          });
          log('✅', 'Produit mis à jour', 2);
          stats.updated++;
          await syncProductToSupabase(updatedProduct);
          product = { ...updatedProduct, prices: product.prices };
        }
      } else {
        log('⏭️ ', 'Pas de changements', 2);
        stats.skipped++;
      }
    }

    // Synchroniser les prix tiered metered
    for (const priceConfig of meteredProduct.prices) {
      const existingPrice = product.prices?.find(p =>
        p.lookup_key && p.lookup_key === priceConfig.lookup_key
      );

      if (!existingPrice) {
        log('➕', `Nouveau prix tiered: ${priceConfig.lookup_key}`, 3);

        if (!isDryRun) {
          const price = await stripe.prices.create({
            product: product.id,
            currency: priceConfig.currency,
            billing_scheme: 'tiered',
            tiers_mode: 'graduated',
            tiers: [
              {
                up_to: priceConfig.included_credits,
                flat_amount: priceConfig.flat_amount,
                unit_amount: 0,
              },
              {
                up_to: 'inf',
                flat_amount: 0,
                unit_amount_decimal: priceConfig.overage_unit_amount_decimal,
              },
            ],
            recurring: {
              interval: priceConfig.interval,
              interval_count: 1,
              meter: meteredProduct.meter_id,
              usage_type: 'metered',
            },
            lookup_key: priceConfig.lookup_key,
            active: priceConfig.active,
            metadata: {
              namespace: BILLING_NAMESPACE,
              synced: 'true',
            },
          });

          log('✅', `Prix tiered créé: ${price.id} (${priceConfig.included_credits} inclus/${priceConfig.interval})`, 3);
          stats.pricesCreated++;

          await syncPriceToSupabase(price);
        } else {
          log('🔍', `[DRY-RUN] Prix tiered serait créé`, 3);
        }
      } else {
        log('⏭️ ', `Prix existant: ${existingPrice.id}`, 3);
      }
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ METERED PRODUCTS');
  console.log('═══════════════════════════════════════════════════════════\n');
  log('➕', `Produits créés: ${stats.created}`);
  log('🔄', `Produits mis à jour: ${stats.updated}`);
  log('⏭️ ', `Produits inchangés: ${stats.skipped}`);
  log('💰', `Prix tiered créés: ${stats.pricesCreated}`);
  console.log('');
}

// ============================================================================
// EXÉCUTION
// ============================================================================

syncProducts()
  .then(() => syncMeteredProducts())
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Erreur:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
