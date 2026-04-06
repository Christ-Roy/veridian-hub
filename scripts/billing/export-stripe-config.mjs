#!/usr/bin/env node

/**
 * Script temporaire pour exporter la configuration Stripe actuelle
 * Usage: node scripts/export-stripe-config.mjs [dev|preprod]
 */

import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Déterminer quelle clé utiliser
const mode = process.argv[2] || 'dev';
let stripeSecretKey;

if (mode === 'preprod') {
  stripeSecretKey = envVars.STRIPE_SECRET_KEY_PREPROD;
  console.log('🔑 Mode PREPROD détecté');
} else {
  stripeSecretKey = envVars.STRIPE_SECRET_KEY;
  console.log('🔑 Mode DEV détecté');
}

if (!stripeSecretKey) {
  console.error('❌ Clé Stripe non trouvée dans .env');
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-12-18.acacia'
});

async function exportStripeConfig() {
  console.log('\n📦 Récupération des produits Stripe...');

  // Récupérer tous les produits
  const products = await stripe.products.list({
    limit: 100,
    expand: ['data.default_price']
  });

  console.log(`✅ ${products.data.length} produits trouvés`);

  // Récupérer tous les prix pour chaque produit
  const config = {
    exported_at: new Date().toISOString(),
    stripe_mode: stripeSecretKey.startsWith('sk_live_') ? 'live' : 'test',
    environment: mode,
    products: []
  };

  for (const product of products.data) {
    console.log(`\n📄 Produit: ${product.name} (${product.id})`);

    // Récupérer tous les prix pour ce produit
    const prices = await stripe.prices.list({
      product: product.id,
      limit: 100
    });

    console.log(`   💰 ${prices.data.length} prix trouvés`);

    config.products.push({
      stripe_id: product.id,
      name: product.name,
      description: product.description,
      active: product.active,
      metadata: product.metadata,
      images: product.images,
      features: product.features || [],
      default_price: product.default_price,
      prices: prices.data.map(price => ({
        stripe_id: price.id,
        active: price.active,
        currency: price.currency,
        unit_amount: price.unit_amount,
        recurring: price.recurring ? {
          interval: price.recurring.interval,
          interval_count: price.recurring.interval_count,
          trial_period_days: price.recurring.trial_period_days
        } : null,
        type: price.type,
        billing_scheme: price.billing_scheme,
        lookup_key: price.lookup_key,
        metadata: price.metadata,
        nickname: price.nickname,
        tax_behavior: price.tax_behavior
      }))
    });
  }

  // Sauvegarder le fichier JSON
  const outputPath = path.join(__dirname, `../../stripe-config-export-${mode}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));

  console.log(`\n✅ Configuration exportée dans: ${outputPath}`);
  console.log(`\n📊 Résumé:`);
  console.log(`   - Produits: ${config.products.length}`);
  console.log(`   - Prix totaux: ${config.products.reduce((sum, p) => sum + p.prices.length, 0)}`);

  // Afficher un aperçu des produits
  console.log(`\n📋 Produits trouvés:`);
  config.products.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.name} (${p.active ? '✅' : '❌'})`);
    console.log(`      - ID: ${p.stripe_id}`);
    console.log(`      - Metadata: ${JSON.stringify(p.metadata)}`);
    console.log(`      - Prix: ${p.prices.length} (${p.prices.filter(pr => pr.active).length} actifs)`);
  });
}

exportStripeConfig().catch(err => {
  console.error('❌ Erreur:', err.message);
  process.exit(1);
});
