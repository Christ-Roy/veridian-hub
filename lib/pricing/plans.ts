// lib/pricing/plans.ts
//
// 🔥 ADAPTATEUR vers @veridian/shared (Git submodule veridian-infra).
//
// Source de vérité numérique : `shared/shared/pricing/plans.ts` (canonique
// cross-app, aligné PRICING-VERIDIAN.md v1.1). Ce fichier RE-MAPPE vers le
// shape historique Hub pour ne pas casser :
//   - `app/(marketing)/pricing/page.tsx`
//   - `components/pricing/PricingGrid.tsx`
//   - `app/dashboard/page.tsx` (consomme APPS)
//   - `__tests__/lib/pricing/plans.test.ts`
//   - les helpers `lib/pricing/helpers.ts`
//
// RÉTRO-COMPAT : la clé `prospection-enterprise` (héritée pré-2026-05-21)
// est conservée comme alias vers `prospection-business`. À retirer dans un
// sprint suivant après audit des consommateurs LEGACY_STRIPE_PRICE_MAPPING.

import {
  PLANS as CANONICAL_PLANS,
  type Plan as CanonicalPlan,
  type PlanKey as CanonicalPlanKey,
  type FeatureKey,
} from '@veridian/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types Hub (shape historique, conservé pour rétro-compat consommateurs)
// ─────────────────────────────────────────────────────────────────────────────

export type PlanKey =
  // Plans Notifuse à la carte
  | 'notifuse-free'
  | 'notifuse-pro'
  | 'notifuse-business'
  // Plans Prospection à la carte
  | 'prospection-free'
  | 'prospection-pro'
  | 'prospection-business' // canonique v1.1
  | 'prospection-enterprise' // alias LEGACY (= prospection-business)
  // Bundles cross-app (prix dégressif)
  | 'veridian-pro'
  | 'veridian-business'
  // Plans offerts (manuels, non-Stripe, immune aux downgrades) — cf §3.3 contrat
  | 'lifetime-site-vitrine'
  | 'lifetime-partner'
  | 'internal';

export type Interval = 'month' | 'year';

export interface PlanFeature {
  /** Texte affiché côté UI (français). */
  label: string;
  /** Si false, affiche le label barré (feature absente de ce plan). */
  included: boolean;
}

export interface AppQuotas {
  /** Quotas par app. Une valeur null = "sans objet" (l'app n'est pas incluse). */
  notifuse?: {
    emails_per_month: number | 'unlimited';
    members_max: number | 'unlimited';
  } | null;
  prospection?: {
    leads_total: number | 'unlimited';
    members_max: number | 'unlimited';
  } | null;
}

export type VeridianApp = 'notifuse' | 'prospection' | 'analytics' | 'cms';

export interface Plan {
  key: PlanKey;
  name: string;
  tagline: string;
  price_eur: number;
  price_eur_yearly_per_month: number | null;
  stripePriceId: {
    month: string | null;
    year: string | null;
  };
  apps: ('notifuse' | 'prospection')[];
  members_seats: number | 'unlimited';
  quotas: AppQuotas;
  features: PlanFeature[];
  rank: number;
  recommended?: boolean;
  hidden_from_public?: boolean;
  plan_source: 'stripe' | 'manual' | 'lifetime_site_vitrine' | 'lifetime_partner' | 'internal';
}

export interface AppMetadata {
  key: VeridianApp;
  display_name: string;
  self_serve: boolean;
  client_only: boolean;
  tagline: string;
  icon: string;
  marketing_url?: string;
}

export const APPS: Record<VeridianApp, AppMetadata> = {
  notifuse: {
    key: 'notifuse',
    display_name: 'Notifuse',
    self_serve: true,
    client_only: false,
    tagline: 'Emails transactionnels',
    icon: '📧',
  },
  prospection: {
    key: 'prospection',
    display_name: 'Prospection',
    self_serve: true,
    client_only: false,
    tagline: 'Qualification de leads .fr',
    icon: '🎯',
  },
  analytics: {
    key: 'analytics',
    display_name: 'Veridian Analytics',
    self_serve: false,
    client_only: true,
    tagline: 'Dashboard multi-tenant (pageviews, GSC, appels SIP)',
    icon: '📊',
    marketing_url: 'https://veridian.site',
  },
  cms: {
    key: 'cms',
    display_name: 'Veridian CMS',
    self_serve: false,
    client_only: true,
    tagline: 'CMS multi-tenant (Payload) pour vos sites',
    icon: '📝',
    marketing_url: 'https://veridian.site',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mapper canonical (shared) → shape Hub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convertit un Plan canonique (shared) vers la shape Hub historique.
 * - features FeatureKey[] → PlanFeature[] (labels FR construits à partir d'une table)
 * - apps_unlocked → apps (filtré aux apps self-serve notifuse/prospection)
 * - seats → members_seats (null → 'unlimited')
 * - stripePriceIdLive → stripePriceId
 * - construit AppQuotas (toujours 'unlimited' depuis le pivot 2026-05-21)
 */
function adaptCanonicalToHub(canonical: CanonicalPlan, key: PlanKey): Plan {
  return {
    key,
    name: canonical.name,
    tagline: canonical.tagline,
    price_eur: canonical.price_eur,
    price_eur_yearly_per_month: canonical.price_eur_yearly_per_month,
    stripePriceId: {
      month: canonical.stripePriceIdLive.month,
      year: canonical.stripePriceIdLive.year,
    },
    apps: canonical.apps_unlocked.filter(
      (a): a is 'notifuse' | 'prospection' => a === 'notifuse' || a === 'prospection',
    ),
    members_seats: canonical.seats === null ? 'unlimited' : canonical.seats,
    quotas: buildAppQuotas(canonical),
    features: buildHubFeatures(canonical),
    rank: canonical.rank,
    recommended: canonical.recommended,
    hidden_from_public: canonical.hidden_from_public,
    plan_source: canonical.plan_source,
  };
}

/**
 * Quotas Hub historiques. Depuis le pivot 2026-05-21 (générosité maximale),
 * tout est `unlimited`. Cette shape reste pour ne pas casser les consommateurs.
 */
function buildAppQuotas(plan: CanonicalPlan): AppQuotas {
  const result: AppQuotas = {};
  if (plan.apps_unlocked.includes('notifuse')) {
    result.notifuse = { emails_per_month: 'unlimited', members_max: 'unlimited' };
  }
  if (plan.apps_unlocked.includes('prospection')) {
    result.prospection = {
      leads_total: plan.welcome_leads || 'unlimited',
      members_max: plan.seats === null ? 'unlimited' : plan.seats,
    };
  }
  return result;
}

/**
 * Construit la liste de PlanFeature affichables côté UI marketing à partir
 * des FeatureKey du canonique + de quelques labels "metadata" (volumes,
 * seats, support) qui ne sont pas dans le shared (UI-only).
 */
function buildHubFeatures(plan: CanonicalPlan): PlanFeature[] {
  const features: PlanFeature[] = [];

  // Volume metadata
  if (plan.apps_unlocked.includes('notifuse')) {
    features.push({ label: 'Emails illimités (BYO sending)', included: true });
  }
  if (plan.apps_unlocked.includes('prospection') && plan.welcome_leads > 0) {
    features.push({
      label: `${plan.welcome_leads.toLocaleString('fr-FR')} leads offerts à la souscription`,
      included: true,
    });
  } else if (plan.apps_unlocked.includes('prospection')) {
    features.push({ label: '100 leads offerts pour tester', included: true });
  }

  // Seats
  if (plan.seats === null) {
    features.push({ label: 'Membres illimités', included: true });
  } else {
    features.push({ label: `${plan.seats} membres`, included: true });
  }

  // Features canoniques mappées en labels FR
  const featureLabels: Partial<Record<FeatureKey, string>> = {
    notifuse_ab_testing: 'A/B testing',
    notifuse_white_label: 'White-label custom',
    notifuse_priority_support: 'Support prioritaire',
    prospection_search_advanced: 'Recherche INPI avancée',
    prospection_icp_scoring: 'Scoring ICP personnalisé',
    prospection_pipeline_advanced: 'Pipeline Kanban avancé',
    prospection_notifuse_sequences: 'Séquences email Notifuse',
    prospection_csv_export: 'Export CSV',
    prospection_api_access: 'Accès API publique',
    prospection_verified_emails: 'Emails vérifiés MX',
    prospection_growth_signals: 'Signaux de croissance',
    bundle_cross_app_seats: 'Seats partagés cross-app',
  };

  for (const [fk, label] of Object.entries(featureLabels)) {
    if (label && plan.features.includes(fk as FeatureKey)) {
      features.push({ label, included: true });
    }
  }

  // Annual perks
  if (plan.annual_perks) {
    features.push({ label: 'Onboarding visio 60min (annuel)', included: true });
  }

  return features;
}

// ─────────────────────────────────────────────────────────────────────────────
// CATALOGUE — projection des plans canoniques en shape Hub
// ─────────────────────────────────────────────────────────────────────────────

const HUB_PLANS_FROM_SHARED: Record<CanonicalPlanKey, Plan> = {
  'notifuse-free': adaptCanonicalToHub(CANONICAL_PLANS['notifuse-free'], 'notifuse-free'),
  'notifuse-pro': adaptCanonicalToHub(CANONICAL_PLANS['notifuse-pro'], 'notifuse-pro'),
  'notifuse-business': adaptCanonicalToHub(CANONICAL_PLANS['notifuse-business'], 'notifuse-business'),
  'prospection-free': adaptCanonicalToHub(CANONICAL_PLANS['prospection-free'], 'prospection-free'),
  'prospection-pro': adaptCanonicalToHub(CANONICAL_PLANS['prospection-pro'], 'prospection-pro'),
  'prospection-business': adaptCanonicalToHub(CANONICAL_PLANS['prospection-business'], 'prospection-business'),
  'veridian-pro': adaptCanonicalToHub(CANONICAL_PLANS['veridian-pro'], 'veridian-pro'),
  'veridian-business': adaptCanonicalToHub(CANONICAL_PLANS['veridian-business'], 'veridian-business'),
  'lifetime-site-vitrine': adaptCanonicalToHub(CANONICAL_PLANS['lifetime-site-vitrine'], 'lifetime-site-vitrine'),
  'lifetime-partner': adaptCanonicalToHub(CANONICAL_PLANS['lifetime-partner'], 'lifetime-partner'),
  'internal': adaptCanonicalToHub(CANONICAL_PLANS['internal'], 'internal'),
};

/**
 * Alias LEGACY — `prospection-enterprise` était utilisé avant le pivot
 * 2026-05-21 pour désigner le tier business Prospection. Conservé ici pour
 * ne pas casser :
 *  - `helpers.ts:getAppPlansForBundle()` (bundle veridian-business → prospection-enterprise)
 *  - `LEGACY_STRIPE_PRICE_MAPPING` (au cas où une subscription Stripe prod référence encore ce nom)
 *  - Composants UI hypothétiques qui hardcodent la clé
 *
 * À supprimer après audit complet : grep `prospection-enterprise` doit
 * être vide hors fichiers de migration.
 */
const PROSPECTION_ENTERPRISE_ALIAS: Plan = {
  ...HUB_PLANS_FROM_SHARED['prospection-business'],
  key: 'prospection-enterprise',
  name: 'Prospection Enterprise (alias legacy)',
  hidden_from_public: true, // ne PAS afficher dans /pricing — le canonique business l'est déjà
};

export const PLANS: Record<PlanKey, Plan> = {
  ...HUB_PLANS_FROM_SHARED,
  'prospection-enterprise': PROSPECTION_ENTERPRISE_ALIAS,
};

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING LEGACY — pour ne pas casser les subscriptions Stripe actives en prod
// ─────────────────────────────────────────────────────────────────────────────

export const LEGACY_STRIPE_PRICE_MAPPING: Record<string, PlanKey> = {
  // À remplir au prochain audit Stripe prod
};

// ─────────────────────────────────────────────────────────────────────────────
// SOURCES DE VÉRITÉ DÉRIVÉES (helpers — voir lib/pricing/helpers.ts pour API)
// ─────────────────────────────────────────────────────────────────────────────

/** Tous les plans visibles sur la page /pricing publique. */
export const PUBLIC_PLANS: PlanKey[] = (Object.keys(PLANS) as PlanKey[]).filter(
  (k) => !PLANS[k].hidden_from_public,
);

/** Tous les plans payants (pour le checkout). */
export const PAYABLE_PLANS: PlanKey[] = PUBLIC_PLANS.filter(
  (k) => PLANS[k].price_eur > 0,
);

/** Plans offerts (manuels, jamais sur Stripe). */
export const MANUAL_PLANS: PlanKey[] = (Object.keys(PLANS) as PlanKey[]).filter(
  (k) => PLANS[k].plan_source !== 'stripe',
);
