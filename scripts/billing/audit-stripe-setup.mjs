#!/usr/bin/env node

/**
 * AUDIT COMPLET DU SYSTÈME STRIPE
 *
 * Analyse tous les aspects :
 * - Webhooks configurés (TEST + LIVE)
 * - Produits/prix dans Stripe
 * - Webhooks secrets
 * - Événements récents
 */

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

console.log('═══════════════════════════════════════════════════════════');
console.log('🔍 AUDIT COMPLET DU SYSTÈME STRIPE');
console.log('═══════════════════════════════════════════════════════════\n');

// ============================================================================
// 1. VARIABLES D'ENVIRONNEMENT
// ============================================================================
console.log('📋 1. VARIABLES D\'ENVIRONNEMENT');
console.log('─'.repeat(60));

const vars = [
  'DOMAIN',
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_LIVE',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE'
];

vars.forEach(v => {
  const value = envVars[v];
  const exists = !!value;
  const prefix = exists ? (value.includes('sk_live') || value.includes('pk_live') ? '🔴 LIVE' : '🟢 TEST') : '❌ MANQUANT';
  const display = exists ? `${value.substring(0, 20)}...` : 'NON DÉFINI';
  console.log(`   ${prefix.padEnd(10)} ${v.padEnd(40)} ${display}`);
});

console.log('');

// ============================================================================
// 2. STRIPE TEST
// ============================================================================
console.log('🟢 2. STRIPE TEST (Dev)');
console.log('─'.repeat(60));

const stripeTest = new Stripe(envVars.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia'
});

// Webhooks TEST
const webhooksTest = await stripeTest.webhookEndpoints.list({ limit: 100 });
console.log(`   Webhooks configurés: ${webhooksTest.data.length}`);
webhooksTest.data.forEach(w => {
  console.log(`   • ${w.url}`);
  console.log(`     Status: ${w.status}`);
  console.log(`     Events: ${w.enabled_events.length} types`);
});
console.log('');

// Produits TEST
const productsTest = await stripeTest.products.list({ limit: 100 });
const veridianProductsTest = productsTest.data.filter(p =>
  p.metadata.namespace === 'veridian'
);
console.log(`   Produits Veridian: ${veridianProductsTest.length}`);

for (const product of veridianProductsTest) {
  const prices = await stripeTest.prices.list({ product: product.id, limit: 100 });
  console.log(`   📦 ${product.name} (${prices.data.length} prix)`);
  prices.data.forEach(p => {
    const lookup = p.lookup_key || 'NO LOOKUP';
    console.log(`      💰 ${p.unit_amount ? p.unit_amount/100 : '?'}€/${p.recurring?.interval || 'one-time'} | ${lookup}`);
  });
}

console.log('');

// ============================================================================
// 3. STRIPE LIVE
// ============================================================================
console.log('🔴 3. STRIPE LIVE (Production)');
console.log('─'.repeat(60));

if (!envVars.STRIPE_SECRET_KEY_LIVE) {
  console.log('   ❌ Clé LIVE non configurée - SKIP\n');
} else {
  const stripeLive = new Stripe(envVars.STRIPE_SECRET_KEY_LIVE, {
    apiVersion: '2024-12-18.acacia'
  });

  // Webhooks LIVE
  const webhooksLive = await stripeLive.webhookEndpoints.list({ limit: 100 });
  console.log(`   Webhooks configurés: ${webhooksLive.data.length}`);
  webhooksLive.data.forEach(w => {
    console.log(`   • ${w.url}`);
    console.log(`     Status: ${w.status}`);
    console.log(`     Events: ${w.enabled_events.length} types`);
  });
  console.log('');

  // Produits LIVE
  const productsLive = await stripeLive.products.list({ limit: 100 });
  const veridianProductsLive = productsLive.data.filter(p =>
    p.metadata.namespace === 'veridian'
  );
  console.log(`   Produits Veridian: ${veridianProductsLive.length}`);

  for (const product of veridianProductsLive) {
    const prices = await stripeLive.prices.list({ product: product.id, limit: 100 });
    console.log(`   📦 ${product.name} (${prices.data.length} prix)`);
    prices.data.forEach(p => {
      const lookup = p.lookup_key || 'NO LOOKUP';
      console.log(`      💰 ${p.unit_amount ? p.unit_amount/100 : '?'}€/${p.recurring?.interval || 'one-time'} | ${lookup}`);
    });
  }

  console.log('');
}

// ============================================================================
// 4. RÉSUMÉ
// ============================================================================
console.log('📊 4. RÉSUMÉ');
console.log('─'.repeat(60));
console.log(`   Domain actuel: ${envVars.DOMAIN || 'NON DÉFINI'}`);
console.log(`   Dev: dev.veridian.site`);
console.log(`   Prod: app.veridian.site\n`);

console.log('✅ Audit terminé\n');
