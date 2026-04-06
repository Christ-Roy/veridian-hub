#!/usr/bin/env node
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
console.log('🗄️  Archivage des prix avec lookup_keys utilisées...\n');

const lookupKeysToArchive = [
  'veridian_pro_monthly_v2',
  'veridian_pro_yearly_v2',
  'veridian_enterprise_monthly_v5',
  'veridian_enterprise_yearly_v5'
];

for (const lookupKey of lookupKeysToArchive) {
  try {
    const prices = await stripe.prices.search({
      query: `lookup_key:"${lookupKey}"`
    });

    if (prices.data.length > 0) {
      for (const price of prices.data) {
        await stripe.prices.update(price.id, {
          lookup_key: null,
          active: false
        });
        console.log(`✅ Archivé: ${lookupKey} (${price.id})`);
      }
    } else {
      console.log(`⚠️  Aucun prix trouvé pour: ${lookupKey}`);
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  } catch (error) {
    console.log(`❌ Erreur pour ${lookupKey}: ${error.message}`);
  }
}

console.log('\n✅ Archivage terminé\n');
