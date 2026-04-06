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

console.log('🔍 Récupération des prix v4...\n');

// Récupérer les prix v4
const pricesV4 = [
  'price_1SsVENRgvfRggzUN5UJslLMz', // Enterprise monthly v4
  'price_1SsVEORgvfRggzUN78kNgtmB'  // Enterprise yearly v4
];

for (const priceId of pricesV4) {
  console.log(`📦 Récupération du prix ${priceId}...`);
  const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });

  // Créer le payload de l'événement price.created
  const event = {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: price
    },
    livemode: true,
    pending_webhooks: 1,
    request: {
      id: null,
      idempotency_key: null
    },
    type: 'price.created'
  };

  const payload = JSON.stringify(event);

  // Créer la signature Stripe
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  const stripeSignature = `t=${timestamp},v1=${signature}`;

  console.log(`📤 Envoi du webhook vers Twenty...`);

  // Envoyer le webhook
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

  await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`   Status: ${res.statusCode}`);
        console.log(`   Response: ${data}`);
        console.log('');
        resolve();
      });
    });

    req.on('error', (error) => {
      console.log(`   ❌ Erreur: ${error.message}`);
      console.log('');
      resolve();
    });

    req.write(payload);
    req.end();
  });

  // Attendre 1 seconde entre chaque requête
  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log('\n✅ Webhooks envoyés !');
console.log('Vérifiez maintenant dans Twenty si les prix ont été synchronisés.');
