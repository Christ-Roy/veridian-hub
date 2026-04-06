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
  if (match) envVars[match[1]] = match[2];
});

const stripe = new Stripe(envVars.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia'
});

console.log('🔍 Vérification du webhook Dashboard dans Stripe TEST\n');

const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
const dashboardWebhook = webhooks.data.find(w => w.url.includes('dev.veridian.site/api/webhooks'));

if (!dashboardWebhook) {
  console.log('❌ Webhook Dashboard non trouvé dans Stripe TEST !');
  console.log('   Webhooks disponibles:');
  webhooks.data.forEach(w => console.log(`   - ${w.url}`));
  process.exit(1);
}

console.log(`✅ Webhook Dashboard trouvé: ${dashboardWebhook.url}`);
console.log(`   ID: ${dashboardWebhook.id}`);
console.log(`   Status: ${dashboardWebhook.status}`);
console.log(`   Events: ${dashboardWebhook.enabled_events.includes('price.created') ? '✅ price.created inclus' : '❌ price.created MANQUANT'}`);
console.log(`   API Version: ${dashboardWebhook.api_version}`);

// Récupérer les derniers événements créés
console.log('\n📨 Derniers événements price.created créés (récents):');

// Récupérer les événements récents
const events = await stripe.events.list({
  limit: 10,
  types: ['price.created']
});

console.log(`   Événements price.created récents: ${events.data.length}`);
if (events.data.length === 0) {
  console.log('\n⚠️  Aucun événement price.created récent.');
  console.log('   Cela peut signifier que:');
  console.log('   1. Stripe n\'a jamais envoyé ces événements vers notre webhook');
  console.log('   2. Les événements ont été envoyés mais sont très anciens');
  console.log('   3. Le webhook a échoué silencieusement (signature invalide)');
  console.log('\n💡 Solution: Recréer le webhook avec le bon secret TEST');
} else {
  events.data.forEach(e => {
    console.log(`   - ${e.id} (créé: ${new Date(e.created * 1000).toLocaleString()})`);
  });
}
