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

console.log('🔍 Recherche des événements price.created pour les prix v4...\n');

const pricesV4 = [
  'price_1SsVENRgvfRggzUN5UJslLMz', // Enterprise monthly v4
  'price_1SsVEORgvfRggzUN78kNgtmB'  // Enterprise yearly v4
];

const pricesPro = [
  'price_1SoXkSRgvfRggzUNXfY5cCaZ', // Pro monthly v1
  'price_1SoXkcRgvfRggzUNQILwv9wC'  // Pro yearly v1
];

const allPrices = [...pricesV4, ...pricesPro];

// Récupérer tous les événements price.created récents
const events = await stripe.events.list({
  limit: 100,
  types: ['price.created']
});

console.log('📨 Événements price.created trouvés:\n');

const eventIds = [];

for (const event of events.data) {
  const price = event.data.object;
  if (allPrices.includes(price.id)) {
    const time = new Date(event.created * 1000).toLocaleString();
    console.log(`✅ ${event.id}`);
    console.log(`   Prix: ${price.id} - ${price.unit_amount/100}€/${price.recurring?.interval}`);
    console.log(`   Lookup: ${price.lookup_key}`);
    console.log(`   Créé: ${time}\n`);
    eventIds.push(event.id);
  }
}

if (eventIds.length === 0) {
  console.log('❌ Aucun événement trouvé pour les prix v4 et Pro');
} else {
  console.log('\n📋 Commandes pour renvoyer les événements vers Twenty:\n');

  // Récupérer le webhook ID Twenty
  const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
  const twentyWebhook = webhooks.data.find(w => w.url.includes('twenty'));

  if (twentyWebhook) {
    console.log(`💡 Webhook Twenty: ${twentyWebhook.id}\n`);
    for (const eventId of eventIds) {
      console.log(`stripe events resend ${eventId} --webhook-endpoint ${twentyWebhook.id} --live`);
    }
  } else {
    console.log('⚠️  Webhook Twenty non trouvé, envoi vers tous les webhooks:\n');
    for (const eventId of eventIds) {
      console.log(`stripe events resend ${eventId} --live`);
    }
  }
}
