#!/usr/bin/env node

/**
 * Affiche la configuration billing complète (source de vérité)
 * Usage: node scripts/billing/view-billing-config.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION BILLING (Source de vérité)
// Normalement importée depuis billing.config.ts
// ============================================================================

const TRIAL_DAYS = parseInt(process.env.NEXT_PUBLIC_TRIAL_PERIOD_DAYS || '7', 10);

const FREE_PLAN = {
  internal_id: 'freemium',
  name: 'Freemium',
  description: `Essai gratuit de ${TRIAL_DAYS} jours. Accès complet à Twenty CRM et Notifuse.`,
  trial_days: TRIAL_DAYS,
  ui_metadata: {
    display_order: 0,
    features: [
      `${TRIAL_DAYS} jours d'essai gratuit`,
      'Twenty CRM complet',
      'Notifuse Email Marketing',
      '1 utilisateur',
      'Support communautaire'
    ],
    cta_text: 'Commencer gratuitement'
  }
};

const PAID_PLANS = [
  {
    internal_id: 'pro',
    name: 'Pro',
    description: 'Plan Pro - Idéal pour les équipes en croissance qui ont besoin de fonctionnalités avancées et d\'un support prioritaire',
    type: 'LICENSED',
    active: true,

    prices: [
      {
        lookup_key: 'veridian_pro_monthly_v1',
        amount: 2900,
        currency: 'eur',
        interval: 'month',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'unspecified'
      },
      {
        lookup_key: 'veridian_pro_yearly_v1',
        amount: 29000,
        currency: 'eur',
        interval: 'year',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'unspecified'
      }
    ],

    stripe_metadata: {
      planKey: 'PRO',
      priceUsageBased: 'LICENSED',
      productKey: 'BASE_PRODUCT'
    },

    ui_metadata: {
      display_order: 1,
      badge: null,
      features: [
        'Utilisateurs illimités',
        'Twenty CRM avancé',
        'Notifuse sans limite',
        'Workflows automatisés',
        'Support email prioritaire',
        'Analytics avancés'
      ],
      cta_text: 'Souscrire',
      highlighted: false
    }
  },

  {
    internal_id: 'enterprise',
    name: 'Enterprise',
    description: 'Plan Enterprise - Solution complète pour les grandes entreprises avec SSO, SLA garanti et support dédié 24/7',
    type: 'LICENSED',
    active: true,

    prices: [
      {
        lookup_key: 'veridian_enterprise_monthly_v1',
        amount: 3500,
        currency: 'eur',
        interval: 'month',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'exclusive'
      },
      {
        lookup_key: 'veridian_enterprise_yearly_v1',
        amount: 99000,
        currency: 'eur',
        interval: 'year',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'unspecified'
      }
    ],

    stripe_metadata: {
      planKey: 'ENTERPRISE',
      priceUsageBased: 'LICENSED',
      productKey: 'BASE_PRODUCT'
    },

    ui_metadata: {
      display_order: 2,
      badge: 'POPULAR',
      features: [
        'Tout du plan Pro',
        'Équipes multi-utilisateurs',
        'SSO & SAML',
        'SLA 99.9%',
        'Support dédié 24/7',
        'Onboarding personnalisé',
        'API access illimité'
      ],
      cta_text: 'Souscrire',
      highlighted: true
    }
  }
];

// ============================================================================
// AFFICHAGE
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('📋 CONFIGURATION BILLING - SOURCE DE VÉRITÉ');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('📄 Fichier source: /config/billing.config.ts\n');

// ============================================================================
// PLAN GRATUIT (HORS STRIPE)
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('🆓 PLAN GRATUIT (Hors Stripe)');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`🏷️  Nom: ${FREE_PLAN.name}`);
console.log(`🆔 ID interne: ${FREE_PLAN.internal_id}`);
console.log(`📝 Description: ${FREE_PLAN.description}`);
console.log(`⏱️  Durée trial: ${FREE_PLAN.trial_days} jours`);
console.log(`\n📌 Métadonnées UI:`);
console.log(`   - Ordre affichage: ${FREE_PLAN.ui_metadata.display_order}`);
console.log(`   - CTA: "${FREE_PLAN.ui_metadata.cta_text}"`);
console.log(`\n✨ Fonctionnalités:`);
FREE_PLAN.ui_metadata.features.forEach((f, i) => {
  console.log(`   ${i + 1}. ${f}`);
});

// ============================================================================
// PLANS PAYANTS (SYNCHRONISÉS AVEC STRIPE)
// ============================================================================

console.log('\n═══════════════════════════════════════════════════════════');
console.log('💳 PLANS PAYANTS (Synchronisés avec Stripe)');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Total: ${PAID_PLANS.length} plans\n`);

PAID_PLANS.forEach((plan, idx) => {
  console.log(`${'─'.repeat(63)}`);
  console.log(`📦 PLAN ${idx + 1}: ${plan.name.toUpperCase()}`);
  console.log(`${'─'.repeat(63)}\n`);

  console.log(`🆔 ID interne: ${plan.internal_id}`);
  console.log(`📝 Description: ${plan.description}`);
  console.log(`🏷️  Type: ${plan.type}`);
  console.log(`📊 Statut: ${plan.active ? '✅ Actif' : '❌ Inactif'}`);

  console.log(`\n💰 PRIX (${plan.prices.length} tarifs):\n`);

  plan.prices.forEach((price, priceIdx) => {
    const amount = (price.amount / 100).toFixed(2);
    const interval = price.interval === 'month' ? 'mois' : 'an';
    const status = price.active ? '✅' : '❌';

    console.log(`   ${priceIdx + 1}. ${status} ${amount}€/${interval}`);
    console.log(`      - Lookup key: ${price.lookup_key}`);
    console.log(`      - Devise: ${price.currency.toUpperCase()}`);
    console.log(`      - Tax behavior: ${price.tax_behavior}`);
    if (price.trial_period_days) {
      console.log(`      - Trial: ${price.trial_period_days} jours`);
    }
  });

  console.log(`\n🔖 MÉTADONNÉES STRIPE:\n`);
  Object.entries(plan.stripe_metadata).forEach(([key, value]) => {
    console.log(`   - ${key}: ${value}`);
  });

  console.log(`\n📌 MÉTADONNÉES UI:\n`);
  console.log(`   - Ordre affichage: ${plan.ui_metadata.display_order}`);
  console.log(`   - Badge: ${plan.ui_metadata.badge || 'Aucun'}`);
  console.log(`   - Mis en avant: ${plan.ui_metadata.highlighted ? 'Oui' : 'Non'}`);
  console.log(`   - CTA: "${plan.ui_metadata.cta_text}"`);

  console.log(`\n✨ FONCTIONNALITÉS:\n`);
  plan.ui_metadata.features.forEach((feature, i) => {
    console.log(`   ${i + 1}. ${feature}`);
  });

  console.log('');
});

// ============================================================================
// RÉSUMÉ
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('📊 RÉSUMÉ');
console.log('═══════════════════════════════════════════════════════════\n');

const totalPlans = 1 + PAID_PLANS.length; // Freemium + payants
const totalPrices = PAID_PLANS.reduce((sum, p) => sum + p.prices.length, 0);
const activePrices = PAID_PLANS.reduce((sum, p) => sum + p.prices.filter(pr => pr.active).length, 0);

console.log(`📦 Plans totaux: ${totalPlans} (1 gratuit + ${PAID_PLANS.length} payants)`);
console.log(`💰 Prix totaux: ${totalPrices}`);
console.log(`✅ Prix actifs: ${activePrices}`);
console.log(`❌ Prix inactifs: ${totalPrices - activePrices}`);

console.log(`\n🔄 Ordre d'affichage (display_order):\n`);
const allPlans = [FREE_PLAN, ...PAID_PLANS].sort((a, b) =>
  a.ui_metadata.display_order - b.ui_metadata.display_order
);

allPlans.forEach((plan, i) => {
  const badge = plan.ui_metadata.badge ? ` 🏆 ${plan.ui_metadata.badge}` : '';
  const highlight = plan.ui_metadata.highlighted ? ' ⭐' : '';
  console.log(`   ${i + 1}. ${plan.name}${badge}${highlight}`);
});

console.log('\n');
