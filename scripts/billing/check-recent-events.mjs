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

console.log('🔍 Événements Stripe récents (dernières 5 minutes)...\n');

const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;

const events = await stripe.events.list({
  limit: 50,
  created: { gte: fiveMinutesAgo },
  types: ['price.created', 'price.updated', 'product.updated']
});

for (const event of events.data) {
  const time = new Date(event.created * 1000).toLocaleTimeString();
  console.log(`📨 ${event.type} - ${time}`);

  if (event.type === 'price.created') {
    const price = event.data.object;
    console.log(`   Prix: ${price.id} - ${price.unit_amount/100}€/${price.recurring?.interval}`);
    console.log(`   Produit: ${price.product}`);
    console.log(`   Lookup key: ${price.lookup_key || 'AUCUNE'}`);
  } else if (event.type === 'product.updated') {
    const product = event.data.object;
    console.log(`   Produit: ${product.id} - ${product.name}`);
  }
  console.log('');
}

if (events.data.length === 0) {
  console.log('❌ Aucun événement trouvé dans les 5 dernières minutes');
}
