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

console.log('🔍 Recherche des événements price.created pour les nouveaux prix v2/v5...\n');

// IDs des nouveaux prix créés
const newPriceIds = [
  'price_1SsVtLRd7CeMgvtBGafRUan7', // Pro monthly v2
  'price_1SsVtLRd7CeMgvtBfzYq06y7', // Pro yearly v2
  'price_1SsVtMRd7CeMgvtBzpdCvDmM', // Enterprise monthly v5
  'price_1SsVtMRd7CeMgvtBma70WW6X'  // Enterprise yearly v5
];

const events = await stripe.events.list({
  limit: 100,
  types: ['price.created']
});

console.log('📨 Événements price.created trouvés:\n');

const eventIds = [];

for (const event of events.data) {
  const price = event.data.object;
  if (newPriceIds.includes(price.id)) {
    const time = new Date(event.created * 1000).toLocaleString();
    console.log(`✅ ${event.id}`);
    console.log(`   Prix: ${price.id} - ${price.unit_amount/100}€/${price.recurring?.interval}`);
    console.log(`   Lookup: ${price.lookup_key}`);
    console.log(`   Créé: ${time}\n`);
    eventIds.push(event.id);
  }
}

if (eventIds.length === 0) {
  console.log('❌ Aucun événement trouvé pour les prix v2/v5');
  process.exit(1);
}

console.log(`\n📋 Commandes pour renvoyer les événements:\n`);

// Récupérer les webhook IDs
const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
const dashboardWebhook = webhooks.data.find(w => w.url.includes('dev.veridian.site'));
const twentyWebhook = webhooks.data.find(w => w.url.includes('twenty.dev'));

if (dashboardWebhook) {
  console.log(`💡 Webhook Dashboard: ${dashboardWebhook.id}\n`);
}

if (twentyWebhook) {
  console.log(`💡 Webhook Twenty: ${twentyWebhook.id}\n`);
}

console.log('Commandes à exécuter:\n');

for (const eventId of eventIds) {
  console.log(`stripe events resend ${eventId}`);
}

console.log('\n🚀 Renvoi automatique des événements...\n');

// Renvoyer automatiquement les événements
for (const eventId of eventIds) {
  try {
    await stripe.events.retrieve(eventId);
    console.log(`✅ Événement ${eventId} récupéré`);
  } catch (error) {
    console.log(`❌ Erreur pour ${eventId}: ${error.message}`);
  }
}

console.log('\n⚠️  Note: Utilisez le CLI Stripe pour forcer le renvoi:');
console.log('stripe events resend <event_id>\n');
