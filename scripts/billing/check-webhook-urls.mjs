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

console.log('🔍 Webhooks configurés en TEST (Stripe TEST) :\n');

const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });

for (const webhook of webhooks.data) {
  console.log(`📡 ${webhook.url}`);
  console.log(`   ID: ${webhook.id}`);
  console.log(`   Status: ${webhook.status}`);
  console.log(`   Events: ${webhook.enabled_events.slice(0, 5).join(', ')}...`);
  console.log('');
}

console.log(`Total: ${webhooks.data.length} webhooks\n`);
