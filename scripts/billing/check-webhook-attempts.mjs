import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), '../../../infra/.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
let envVars = {};

envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) envVars[match[1]] = match[2];
});

const stripe = new Stripe(envVars.STRIPE_SECRET_KEY_LIVE, {
  apiVersion: '2024-12-18.acacia'
});

console.log('🔍 Vérification des webhooks Twenty dans Stripe...\n');

// Récupérer le webhook Twenty
const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
const twentyWebhook = webhooks.data.find(w => w.url.includes('twenty'));

if (!twentyWebhook) {
  console.log('❌ Webhook Twenty non trouvé');
  process.exit(1);
}

console.log(`✅ Webhook Twenty trouvé:`);
console.log(`   URL: ${twentyWebhook.url}`);
console.log(`   ID: ${twentyWebhook.id}`);
console.log(`   Status: ${twentyWebhook.status}`);
console.log(`   Mode: ${twentyWebhook.livemode ? 'LIVE' : 'TEST'}`);
console.log(`\n📊 Statistiques de livraison:`);
console.log(`   Webhooks disabled: ${twentyWebhook.disabled ? 'OUI ⚠️' : 'NON'}`);

console.log(`\n💡 Pour voir les tentatives de livraison détaillées:`);
console.log(`   1. Aller sur https://dashboard.stripe.com/webhooks/${twentyWebhook.id}`);
console.log(`   2. Cliquer sur l'onglet "Event logs"`);
console.log(`   3. Filtrer par "Failed" pour voir les erreurs`);
console.log(`\n💡 Ou regarder les événements récents:`);
console.log(`   https://dashboard.stripe.com/events`);
