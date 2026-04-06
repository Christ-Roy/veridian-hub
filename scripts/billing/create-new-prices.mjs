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
console.log('💰 Création des nouveaux prix...\n');

// Charger la config
const exportScript = path.join(__dirname, 'export-config.mjs');
execSync(`node ${exportScript}`, { stdio: 'ignore' });

const billingConfigPath = path.join(__dirname, '.billing-config.json');
const billingConfig = JSON.parse(fs.readFileSync(billingConfigPath, 'utf-8'));

// Récupérer les nouveaux produits
const products = await stripe.products.list({ limit: 100 });
const veridianProducts = products.data.filter(p =>
  p.metadata?.namespace === 'veridian' &&
  p.metadata?.productKey === 'BASE_PRODUCT' &&
  p.active === true
);

console.log(`✅ ${veridianProducts.length} nouveaux produits actifs trouvés\n`);

for (const product of veridianProducts) {
  console.log(`📦 ${product.name} (${product.id})`);

  // Trouver le plan correspondant
  const plan = billingConfig.plans.find(p => p.stripe_metadata.planKey === product.metadata.planKey);

  if (!plan) {
    console.log(`   ⚠️  Plan non trouvé dans la config`);
    continue;
  }

  // Créer les prix
  for (const priceConfig of plan.prices) {
    if (!priceConfig.active) continue;

    try {
      const newPrice = await stripe.prices.create({
        product: product.id,
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
      console.log(`   ✅ ${amount} EUR/${priceConfig.interval} (${newPrice.id})`);

      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.log(`   ❌ Erreur: ${error.message}`);
    }
  }

  console.log('');
}

console.log('✅ Création terminée\n');
