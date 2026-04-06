#!/usr/bin/env node

/**
 * Analyse de la configuration Stripe actuelle (DEV)
 * Génère un rapport détaillé pour migration vers billing.config.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exportFile = path.join(__dirname, '../../stripe-config-export-dev.json');
const config = JSON.parse(fs.readFileSync(exportFile, 'utf-8'));

console.log('═══════════════════════════════════════════════════════════');
console.log('📊 ANALYSE DE LA CONFIGURATION STRIPE DEV');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Export date: ${config.exported_at}`);
console.log(`Stripe mode: ${config.stripe_mode}`);
console.log(`Total products: ${config.products.length}\n`);

// Filtrer les produits pertinents
const baseProducts = config.products.filter(p =>
  p.active && p.metadata.productKey === 'BASE_PRODUCT'
);

const meteredProducts = config.products.filter(p =>
  p.active && p.metadata.productKey === 'WORKFLOW_NODE_EXECUTION'
);

const obsoleteProducts = config.products.filter(p =>
  !p.active || (!p.metadata.productKey && p.name !== 'myproduct')
);

const testProducts = config.products.filter(p =>
  p.name === 'myproduct' || p.description?.includes('created by Stripe CLI')
);

console.log('═══════════════════════════════════════════════════════════');
console.log('✅ PRODUITS BASE ACTIFS (À MIGRER)');
console.log('═══════════════════════════════════════════════════════════\n');

baseProducts
  .sort((a, b) => parseInt(a.metadata.index || 999) - parseInt(b.metadata.index || 999))
  .forEach((product, i) => {
    console.log(`${i + 1}. ${product.name.toUpperCase()}`);
    console.log(`   Stripe ID: ${product.stripe_id}`);
    console.log(`   Description: ${product.description}`);
    console.log(`   Metadata:`);
    console.log(`     - index: ${product.metadata.index}`);
    console.log(`     - planKey: ${product.metadata.planKey}`);
    console.log(`     - priceUsageBased: ${product.metadata.priceUsageBased}`);
    console.log(`     - productKey: ${product.metadata.productKey}`);

    const activePrices = product.prices.filter(p => p.active);
    console.log(`   Prix actifs: ${activePrices.length}/${product.prices.length}`);

    activePrices.forEach(price => {
      const amount = price.unit_amount / 100;
      const interval = price.recurring?.interval || 'N/A';
      console.log(`     - ${amount}€/${interval} (${price.stripe_id})`);
      console.log(`       lookup_key: ${price.lookup_key || 'AUCUNE'}`);
      console.log(`       tax_behavior: ${price.tax_behavior}`);
      if (price.recurring?.trial_period_days) {
        console.log(`       trial: ${price.recurring.trial_period_days} jours`);
      }
    });
    console.log('');
  });

console.log('═══════════════════════════════════════════════════════════');
console.log('⚙️  PRODUITS METERED (Twenty CRM - À IGNORER)');
console.log('═══════════════════════════════════════════════════════════\n');

meteredProducts.forEach((product, i) => {
  console.log(`${i + 1}. ${product.name}`);
  console.log(`   Stripe ID: ${product.stripe_id}`);
  console.log(`   planKey: ${product.metadata.planKey}`);
  console.log(`   Prix: ${product.prices.length} (${product.prices.filter(p => p.active).length} actifs)`);
  console.log('');
});

console.log('═══════════════════════════════════════════════════════════');
console.log('🗑️  PRODUITS OBSOLÈTES/TESTS (À IGNORER PAR LE SCRIPT)');
console.log('═══════════════════════════════════════════════════════════\n');

[...obsoleteProducts, ...testProducts]
  .filter((v, i, a) => a.findIndex(t => t.stripe_id === v.stripe_id) === i) // Dedupe
  .forEach((product, i) => {
    console.log(`${i + 1}. ${product.name} (${product.active ? '✅ actif' : '❌ inactif'})`);
    console.log(`   Stripe ID: ${product.stripe_id}`);
    console.log(`   Description: ${product.description || 'N/A'}`);
    console.log(`   Metadata: ${JSON.stringify(product.metadata)}`);
    console.log('');
  });

console.log('═══════════════════════════════════════════════════════════');
console.log('📝 CONFIGURATION TYPESCRIPT À GÉNÉRER');
console.log('═══════════════════════════════════════════════════════════\n');

baseProducts
  .sort((a, b) => parseInt(a.metadata.index || 999) - parseInt(b.metadata.index || 999))
  .forEach(product => {
    const planId = product.metadata.planKey.toLowerCase();
    console.log(`{
  internal_id: '${planId}',
  name: '${product.name}',
  description: '${product.description}',
  type: 'LICENSED',
  active: true,

  prices: [`);

    product.prices.filter(p => p.active).forEach(price => {
      const interval = price.recurring?.interval;
      console.log(`    {
      lookup_key: '${planId}_${interval}_v1',
      amount: ${price.unit_amount},
      currency: '${price.currency}',
      interval: '${interval}',
      interval_count: ${price.recurring?.interval_count || 1},
      trial_period_days: ${price.recurring?.trial_period_days || 'null'},
      active: true,
      tax_behavior: '${price.tax_behavior}'
    },`);
    });

    console.log(`  ],

  stripe_metadata: {
    planKey: '${product.metadata.planKey}',
    priceUsageBased: '${product.metadata.priceUsageBased}',
    productKey: '${product.metadata.productKey}'
  },

  ui_metadata: {
    display_order: ${product.metadata.index},
    features: [
      // TODO: Définir les features
    ],
    cta_text: 'Souscrire'
  }
},
`);
  });

console.log('═══════════════════════════════════════════════════════════');
console.log('🎯 RÉSUMÉ DE LA MIGRATION');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`✅ Produits à synchroniser: ${baseProducts.length}`);
console.log(`⚙️  Produits metered (ignorés): ${meteredProducts.length}`);
console.log(`🗑️  Produits obsolètes (ignorés): ${obsoleteProducts.length + testProducts.length}`);
console.log(`📦 Prix actifs totaux: ${baseProducts.reduce((sum, p) => sum + p.prices.filter(pr => pr.active).length, 0)}`);

console.log('\n⚠️  POINTS D\'ATTENTION:');
console.log('   - Aucun prix n\'a de lookup_key actuellement');
console.log('   - Le script devra créer les lookup_keys lors de la première sync');
console.log('   - Les produits metered de Twenty doivent être ignorés (namespace)');
console.log('   - Plan "Starter" est inactif mais garde ses prix (grandfathering)');
