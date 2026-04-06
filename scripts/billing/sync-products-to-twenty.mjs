import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';

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

const TWENTY_WEBHOOK_URL = 'https://twenty.app.veridian.site/webhooks/stripe';
const WEBHOOK_SECRET = envVars.TWENTY_STRIPE_WEBHOOK_SECRET_LIVE;

async function sendWebhook(eventType, objectData) {
  const event = {
    id: `evt_manual_${Date.now()}_${Math.random()}`,
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: objectData
    },
    livemode: true,
    pending_webhooks: 1,
    request: {
      id: null,
      idempotency_key: null
    },
    type: eventType
  };

  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  const stripeSignature = `t=${timestamp},v1=${signature}`;

  const url = new URL(TWENTY_WEBHOOK_URL);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Stripe-Signature': stripeSignature
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

console.log('🚀 Synchronisation manuelle des produits et prix vers Twenty\n');

// 1. Envoyer les produits
console.log('📦 Étape 1 : Synchronisation des produits...\n');

const productIds = ['prod_Tm5wKaQayjxPhL', 'prod_Tm5w2QIzYOc2jL'];

for (const productId of productIds) {
  console.log(`   Récupération du produit ${productId}...`);
  const product = await stripe.products.retrieve(productId);

  console.log(`   Envoi de product.updated pour ${product.name}...`);
  const result = await sendWebhook('product.updated', product);
  console.log(`   → Status: ${result.status} - ${result.body}`);

  await new Promise(resolve => setTimeout(resolve, 500));
}

console.log('\n💰 Étape 2 : Synchronisation des prix v4...\n');

// 2. Envoyer les prix avec produit expandé
const pricesV4 = [
  'price_1SsVENRgvfRggzUN5UJslLMz', // Enterprise monthly v4
  'price_1SsVEORgvfRggzUN78kNgtmB'  // Enterprise yearly v4
];

for (const priceId of pricesV4) {
  console.log(`   Récupération du prix ${priceId}...`);
  const price = await stripe.prices.retrieve(priceId);
  // Ne pas expand le product, garder juste l'ID string

  console.log(`   Envoi de price.created pour ${price.unit_amount/100}€/${price.recurring.interval}...`);
  const result = await sendWebhook('price.created', price);
  console.log(`   → Status: ${result.status} - ${result.body}`);

  await new Promise(resolve => setTimeout(resolve, 500));
}

// 3. Envoyer aussi les prix Pro (qui n'ont peut-être jamais été synchronisés)
console.log('\n💰 Étape 3 : Synchronisation des prix Pro...\n');

const pricesPro = [
  'price_1SoXkSRgvfRggzUNXfY5cCaZ', // Pro monthly v1
  'price_1SoXkcRgvfRggzUNQILwv9wC'  // Pro yearly v1
];

for (const priceId of pricesPro) {
  console.log(`   Récupération du prix ${priceId}...`);
  const price = await stripe.prices.retrieve(priceId);
  // Ne pas expand le product, garder juste l'ID string

  console.log(`   Envoi de price.created pour ${price.unit_amount/100}€/${price.recurring.interval}...`);
  const result = await sendWebhook('price.created', price);
  console.log(`   → Status: ${result.status} - ${result.body}`);

  await new Promise(resolve => setTimeout(resolve, 500));
}

console.log('\n✅ Synchronisation terminée !');
console.log('\nVérification dans Twenty dans 3 secondes...');
await new Promise(resolve => setTimeout(resolve, 3000));
