#!/usr/bin/env node
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '../../../infra/.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
let envVars = {};

envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) envVars[match[1]] = match[2].replace(/^"|"$/g, '');
});

const stripe = new Stripe(envVars.STRIPE_SECRET_KEY_LIVE, {
  apiVersion: '2024-12-18.acacia'
});

console.log('🔴 MODE: PRODUCTION (Stripe LIVE)\n');
console.log('💰 Création des NOUVEAUX prix...\n');

// Charger la config
const exportScript = path.join(__dirname, 'export-config.mjs');
execSync(`node ${exportScript}`, { stdio: 'ignore' });

const billingConfigPath = path.join(__dirname, '.billing-config.json');
const billingConfig = JSON.parse(fs.readFileSync(billingConfigPath, 'utf-8'));

// Récupérer les produits actifs
const products = await stripe.products.list({ limit: 100 });
const veridianProducts = products.data.filter(p =>
  p.metadata?.namespace === 'veridian' &&
  p.metadata?.productKey === 'BASE_PRODUCT' &&
  p.active === true
);

console.log(`📦 Produits actifs: ${veridianProducts.length}\n`);

let createdCount = 0;

for (const product of veridianProducts) {
  console.log(`📦 ${product.name} (${product.id})`);

  // Trouver le plan correspondant
  const plan = billingConfig.plans.find(p => p.stripe_metadata.planKey === product.metadata.planKey);

  if (!plan) {
    console.log('   ⚠️  Plan non trouvé dans la config');
    continue;
  }

  // Créer les prix avec nouvelles lookup_keys
  for (const priceConfig of plan.prices) {
    if (!priceConfig.active) continue;

    // Incrémenter la version de la lookup_key
    const newLookupKey = priceConfig.lookup_key.replace(/_v(\d+)$/, (match, version) => {
      return `_v${parseInt(version) + 1}`;
    });

    try {
      const newPrice = await stripe.prices.create({
        product: product.id,
        currency: priceConfig.currency,
        unit_amount: priceConfig.amount,
        recurring: {
          interval: priceConfig.interval,
          interval_count: priceConfig.interval_count || 1
        },
        lookup_key: newLookupKey,
        tax_behavior: priceConfig.tax_behavior || 'unspecified',
        active: true
      });

      const amount = (priceConfig.amount / 100).toFixed(2);
      console.log(`   ✅ ${amount} EUR/${priceConfig.interval} → ${newLookupKey} (${newPrice.id})`);
      createdCount++;

      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.log(`   ❌ Erreur: ${error.message}`);
    }
  }

  console.log('');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 Total créé: ${createdCount} nouveaux prix`);
console.log('✅ Webhooks price.created envoyés vers Twenty');
console.log('\n⏳ Attendre 15 secondes puis vérifier Twenty DB');
