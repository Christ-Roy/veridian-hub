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

console.log('🔍 Événements price.created récents (Stripe TEST):\n');

const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;

const events = await stripe.events.list({
  limit: 20,
  created: { gte: fiveMinutesAgo },
  types: ['price.created']
});

console.log(`Événements trouvés: ${events.data.length}\n`);

// Récupérer le webhook Dashboard
const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
const dashboardWebhook = webhooks.data.find(w => w.url.includes('dev.veridian.site/api/webhooks'));

console.log(`Webhook Dashboard: ${dashboardWebhook ? dashboardWebhook.id : 'NON TROUVÉ'}\n`);

for (const event of events.data) {
  const price = event.data.object;
  const time = new Date(event.created * 1000).toLocaleTimeString();

  console.log(`📨 ${event.type} - ${time}`);
  console.log(`   Prix: ${price.id} - ${price.unit_amount/100}€/${price.recurring?.interval}`);
  console.log(`   Lookup: ${price.lookup_key}`);
  console.log(`   Pending webhooks: ${event.pending_webhooks}`);

  // Note: L'API Stripe ne permet pas de voir le statut de livraison d'un événement passé
  // Il faut aller dans le Dashboard Stripe pour voir les tentatives de livraison
  console.log('');
}
