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

console.log('🔍 Recherche du webhook Twenty dans Stripe...\n');

const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });

for (const webhook of webhooks.data) {
  console.log(`📡 Webhook: ${webhook.url}`);
  console.log(`   Status: ${webhook.status}`);
  console.log(`   Events: ${webhook.enabled_events.join(', ')}`);
  console.log(`   ID: ${webhook.id}`);
  console.log('');
}

// Chercher spécifiquement le webhook Twenty
const twentyWebhook = webhooks.data.find(w => w.url.includes('twenty') || w.url.includes('veridian.site'));
if (twentyWebhook) {
  console.log('✅ Webhook Twenty trouvé:');
  console.log(`   URL: ${twentyWebhook.url}`);
  console.log(`   Events: ${twentyWebhook.enabled_events.join(', ')}`);
} else {
  console.log('❌ Aucun webhook Twenty trouvé !');
}
