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

const products = await stripe.products.list({ active: true, limit: 100 });
const veridianProducts = products.data.filter(p =>
  p.metadata.namespace === 'veridian'
);

for (const product of veridianProducts) {
  console.log(`\n📦 ${product.name} (${product.id})`);
  const prices = await stripe.prices.list({ product: product.id, limit: 100 });

  for (const price of prices.data) {
    const lookupKey = price.lookup_key || 'AUCUNE';
    console.log(`  💰 ${price.id} - ${price.unit_amount/100}€/${price.recurring?.interval}`);
    console.log(`     lookup_key: ${lookupKey}`);
    console.log(`     active: ${price.active}`);
  }
}
