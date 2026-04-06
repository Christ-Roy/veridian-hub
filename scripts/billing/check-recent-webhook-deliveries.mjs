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

console.log('🔍 Événements récents (dernières 2 minutes):\n');

const events = await stripe.events.list({
  limit: 50,
  created: { gte: Math.floor(Date.now() / 1000) - 120 }
});

const productPriceEvents = events.data.filter(e =>
  e.type.startsWith('product.') || e.type.startsWith('price.')
);

console.log(`📊 ${productPriceEvents.length} événements product/price trouvés:\n`);

for (const event of productPriceEvents) {
  console.log(`📅 ${new Date(event.created * 1000).toLocaleTimeString()}`);
  console.log(`   Type: ${event.type}`);
  console.log(`   ID: ${event.id}`);

  if (event.type.startsWith('product.')) {
    console.log(`   Product: ${event.data.object.name} (${event.data.object.id})`);
  } else if (event.type.startsWith('price.')) {
    const price = event.data.object;
    const amount = (price.unit_amount / 100).toFixed(2);
    const interval = price.recurring?.interval || 'one-time';
    console.log(`   Price: ${amount} EUR/${interval} (${price.id})`);
  }

  console.log('');
}
