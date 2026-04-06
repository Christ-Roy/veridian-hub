#!/usr/bin/env node

/**
 * NETTOYAGE DES PRODUITS OBSOLÈTES (POC)
 *
 * ⚠️ ATTENTION : Ce script ARCHIVE des produits dans Stripe
 *
 * Stripe ne permet pas de supprimer complètement les produits/prix.
 * Ce script les archive en:
 * 1. Désactivant tous les prix (active: false)
 * 2. Désactivant le produit (active: false)
 *
 * Les produits archivés ne sont plus visibles dans le frontend
 * mais restent accessibles pour les abonnements existants.
 *
 * Usage:
 *   node scripts/billing/cleanup-obsolete-products.mjs [--env=dev|preprod] [--dry-run] [--force]
 */

import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const forceDelete = args.includes('--force');
const envArg = args.find(arg => arg.startsWith('--env='))?.split('=')[1] || 'dev';

// Charger les variables d'environnement depuis infra/.env
const envPath = path.join(__dirname, '../../../infra/.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};

envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) {
    envVars[match[1]] = match[2];
  }
});

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

const BILLING_NAMESPACE = 'veridian';

// ============================================================================
// CRITÈRES DE SUPPRESSION
// ============================================================================

/**
 * Détermine si un produit doit être supprimé
 */
function shouldDelete(product) {
  // GARDER : Produits Veridian (nos produits actifs)
  if (product.metadata.namespace === BILLING_NAMESPACE) {
    return false;
  }

  // GARDER : Produits Twenty CRM metered (workflows)
  if (product.metadata.productKey === 'WORKFLOW_NODE_EXECUTION') {
    return false;
  }

  // GARDER : Produits BASE_PRODUCT actifs avec metadata correcte
  if (
    product.active &&
    product.metadata.productKey === 'BASE_PRODUCT' &&
    product.metadata.planKey
  ) {
    return false;
  }

  // SUPPRIMER : Produits de test Stripe CLI
  if (product.name === 'myproduct' || product.description?.includes('created by Stripe CLI')) {
    return true;
  }

  // SUPPRIMER : Anciens produits POC sans namespace
  if (
    !product.active &&
    !product.metadata.namespace &&
    !product.metadata.productKey
  ) {
    return true;
  }

  // SUPPRIMER : Produits manuels obsolètes (Business Plan, Pro Plan)
  const obsoleteNames = ['Business Plan', 'Pro Plan', 'Starter'];
  if (obsoleteNames.includes(product.name) && !product.metadata.namespace) {
    return true;
  }

  return false;
}

// ============================================================================
// NETTOYAGE
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('📦 ARCHIVAGE DES PRODUITS OBSOLÈTES');
console.log('═══════════════════════════════════════════════════════════\n');
console.log(`📍 Environnement: ${envLabel}`);
console.log(`🔑 Mode Stripe: ${stripeSecretKey.startsWith('sk_live_') ? 'LIVE' : 'TEST'}`);
console.log(`🔄 Mode: ${isDryRun ? '🔍 DRY-RUN (simulation)' : '✅ EXÉCUTION RÉELLE'}`);
console.log(`⚡ Force: ${forceDelete ? 'OUI' : 'NON'}\n`);

if (!isDryRun && !forceDelete) {
  console.log('⚠️  ATTENTION: Vous allez ARCHIVER des produits dans Stripe !');
  console.log('   Les produits seront désactivés (active: false).');
  console.log('   Ajoutez --force pour confirmer ou --dry-run pour simuler.\n');
  process.exit(1);
}

async function cleanup() {
  console.log('📦 Récupération des produits Stripe...\n');

  const products = await stripe.products.list({
    limit: 100
  });

  console.log(`Total produits trouvés: ${products.data.length}\n`);

  // Classifier les produits
  const toDelete = [];
  const toKeep = [];

  products.data.forEach(product => {
    if (shouldDelete(product)) {
      toDelete.push(product);
    } else {
      toKeep.push(product);
    }
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ PRODUITS À CONSERVER');
  console.log('═══════════════════════════════════════════════════════════\n');

  toKeep.forEach((product, i) => {
    const status = product.active ? '✅' : '❌';
    const reason = product.metadata.namespace === BILLING_NAMESPACE
      ? '(Veridian)'
      : product.metadata.productKey === 'WORKFLOW_NODE_EXECUTION'
      ? '(Twenty CRM metered)'
      : product.metadata.productKey === 'BASE_PRODUCT'
      ? '(BASE_PRODUCT actif)'
      : '(Autre)';

    console.log(`${i + 1}. ${status} ${product.name} ${reason}`);
    console.log(`   ID: ${product.id}`);
    console.log(`   Metadata: ${JSON.stringify(product.metadata)}\n`);
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📦 PRODUITS À ARCHIVER');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (toDelete.length === 0) {
    console.log('✅ Aucun produit à archiver\n');
    return;
  }

  toDelete.forEach((product, i) => {
    const status = product.active ? '✅ actif' : '❌ inactif';
    console.log(`${i + 1}. ${product.name} (${status})`);
    console.log(`   ID: ${product.id}`);
    console.log(`   Description: ${product.description || 'N/A'}`);
    console.log(`   Metadata: ${JSON.stringify(product.metadata)}\n`);
  });

  // Archivage (désactivation)
  if (!isDryRun) {
    console.log('🔄 Archivage en cours...\n');

    let archived = 0;
    let failed = 0;

    for (const product of toDelete) {
      try {
        // Récupérer les prix du produit
        const prices = await stripe.prices.list({
          product: product.id,
          limit: 100
        });

        // Désactiver tous les prix d'abord
        for (const price of prices.data) {
          if (price.active) {
            try {
              await stripe.prices.update(price.id, { active: false });
              console.log(`   📝 Prix désactivé: ${price.id}`);
            } catch (priceErr) {
              console.log(`   ⚠️  Impossible de désactiver le prix ${price.id}: ${priceErr.message}`);
            }
          }
        }

        // Désactiver le produit
        if (product.active) {
          await stripe.products.update(product.id, { active: false });
        }

        console.log(`✅ Archivé: ${product.name} (${product.id})`);
        archived++;
      } catch (err) {
        console.error(`❌ Erreur lors de l'archivage de ${product.name}: ${err.message}`);
        failed++;
      }
    }

    console.log(`\n📊 Résultat: ${archived} archivés, ${failed} échecs`);
  } else {
    console.log('🔍 [DRY-RUN] Les produits ci-dessus seraient archivés (désactivés)\n');
  }

  // Résumé final
  if (!isDryRun) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 RÉSUMÉ FINAL');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`✅ Produits conservés: ${toKeep.length}`);
    console.log(`📦 Produits archivés: ${toDelete.length}`);
    console.log('\n✅ Nettoyage terminé avec succès\n');
  } else {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 RÉSUMÉ');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`✅ Produits conservés: ${toKeep.length}`);
    console.log(`📦 Produits à archiver: ${toDelete.length}\n`);
    console.log('ℹ️  Mode DRY-RUN: Aucune modification réelle effectuée');
    console.log('   Relancez avec --force pour confirmer l\'archivage\n');
  }
}

cleanup()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Erreur:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
