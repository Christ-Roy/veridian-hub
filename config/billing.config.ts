/**
 * BILLING CONFIGURATION - SOURCE DE VÉRITÉ
 *
 * Ce fichier définit tous les plans d'abonnement de la plateforme.
 * Toute modification doit passer par une PR et sera synchronisée vers Stripe via CI/CD.
 *
 * RÈGLES IMPORTANTES:
 * - Ne JAMAIS supprimer un plan existant (grandfathering des abonnés)
 * - Pour modifier un prix, créer une nouvelle lookup_key (ex: pro_monthly_v2)
 * - L'internal_id sert d'identifiant stable entre Code et Stripe
 * - Les metadata UI sont utilisées par le frontend (badges, features, ordre)
 */

export const BILLING_CONFIG_VERSION = '1.1.0';
export const BILLING_NAMESPACE = 'veridian'; // Namespace pour isoler nos produits

/**
 * Stripe Billing Meter ID pour les workflow node executions
 * Créé une seule fois dans Stripe — ne pas recréer
 */
export const WORKFLOW_METER_ID = 'mtr_61U7vcpDWfNLSXDYa41RgvfRggzUNE4e';

/**
 * Type de plan
 */
export type PlanType = 'FREE_TRIAL' | 'LICENSED';

/**
 * Type de pricing (Twenty CRM billing)
 */
export type UsageType = 'LICENSED' | 'METERED';

/**
 * Type de produit (Twenty CRM billing)
 */
export type ProductKey = 'BASE_PRODUCT' | 'WORKFLOW_NODE_EXECUTION';

/**
 * Intervalle de facturation
 */
export type BillingInterval = 'month' | 'year';

/**
 * Badge UI
 */
export type PlanBadge = 'POPULAR' | 'RECOMMENDED' | 'BEST_VALUE' | null;

/**
 * Configuration d'un prix
 */
export interface PriceConfig {
  /** Lookup key unique pour ce prix (ne JAMAIS modifier, créer v2 si besoin) */
  lookup_key: string;

  /** Montant en cents (ex: 2900 = 29€) */
  amount: number;

  /** Devise ISO (eur, usd) */
  currency: 'eur' | 'usd';

  /** Intervalle de facturation */
  interval: BillingInterval;

  /** Nombre d'intervalles (1 = tous les mois, 3 = tous les 3 mois) */
  interval_count?: number;

  /** Jours de trial gratuit (null = pas de trial) */
  trial_period_days?: number | null;

  /** Prix actif (false = obsolète, gardé pour grandfathering) */
  active: boolean;

  /** Nom d'affichage optionnel */
  nickname?: string;

  /** Comportement fiscal */
  tax_behavior?: 'inclusive' | 'exclusive' | 'unspecified';
}

/**
 * Configuration d'un plan
 */
export interface PlanConfig {
  /** ID interne stable (ne JAMAIS changer) */
  internal_id: string;

  /** Nom d'affichage */
  name: string;

  /** Description courte */
  description: string;

  /** Type de plan */
  type: PlanType;

  /** Liste des prix (plusieurs intervalles possibles) */
  prices: PriceConfig[];

  /** Métadonnées Stripe (synchronisées) */
  stripe_metadata: {
    /** Clé du plan (utilisée par Twenty CRM) */
    planKey: string;

    /** Type de pricing (LICENSED ou METERED) */
    priceUsageBased: UsageType;

    /** Type de produit */
    productKey: ProductKey;
  };

  /** Métadonnées UI (affichage frontend) */
  ui_metadata: {
    /** Ordre d'affichage (0 = premier) */
    display_order: number;

    /** Badge optionnel */
    badge?: PlanBadge;

    /** Liste des fonctionnalités */
    features: string[];

    /** URL de l'image (optionnel) */
    image_url?: string;

    /** CTA personnalisé (défaut: "Souscrire") */
    cta_text?: string;

    /** Plan recommandé (highlight) */
    highlighted?: boolean;
  };

  /** Actif (false = caché du frontend, mais Stripe reste actif) */
  active: boolean;
}

/**
 * Configuration d'un prix metered (tiered, lié à un Billing Meter)
 */
export interface MeteredPriceConfig {
  /** Lookup key unique */
  lookup_key: string;

  /** Devise ISO */
  currency: 'eur' | 'usd';

  /** Intervalle de facturation */
  interval: BillingInterval;

  /** Nombre de crédits inclus (tier 1 cap) */
  included_credits: number;

  /** Coût flat pour les crédits inclus (en cents) — 0 = gratuit */
  flat_amount: number;

  /** Coût par crédit excédentaire en cents (decimal string pour Stripe) */
  overage_unit_amount_decimal: string;

  /** Prix actif */
  active: boolean;
}

/**
 * Configuration d'un produit metered (WORKFLOW_NODE_EXECUTION)
 */
export interface MeteredProductConfig {
  /** ID interne stable */
  internal_id: string;

  /** Nom d'affichage */
  name: string;

  /** Description */
  description: string;

  /** Stripe Billing Meter ID */
  meter_id: string;

  /** Prix tiered */
  prices: MeteredPriceConfig[];

  /** Métadonnées Stripe */
  stripe_metadata: {
    planKey: string;
    priceUsageBased: 'METERED';
    productKey: 'WORKFLOW_NODE_EXECUTION';
  };

  /** Actif */
  active: boolean;
}

/**
 * Plan gratuit (hors Stripe)
 */
export interface FreePlanConfig {
  /** ID interne */
  internal_id: string;

  /** Nom d'affichage */
  name: string;

  /** Description courte */
  description: string;

  /** Durée du trial en jours */
  trial_days: number;

  /** Métadonnées UI */
  ui_metadata: {
    display_order: number;
    features: string[];
    cta_text: string;
  };
}

// ============================================================================
// CONFIGURATION DES PLANS
// ============================================================================

/**
 * Plan gratuit (Freemium) - Hors Stripe
 */
export const FREE_PLAN: FreePlanConfig = {
  internal_id: 'freemium',
  name: 'Gratuit',
  description: 'Essai gratuit de 7 jours. Accès complet à Twenty CRM et Notifuse.',
  trial_days: parseInt(process.env.NEXT_PUBLIC_TRIAL_PERIOD_DAYS || '7', 10),
  ui_metadata: {
    display_order: 0,
    features: [
      '7 jours d\'essai gratuit',
      'Twenty CRM complet',
      'Notifuse Email Marketing',
      '1 utilisateur',
      'Support communautaire'
    ],
    cta_text: 'Commencer gratuitement'
  }
};

/**
 * Plans payants (synchronisés avec Stripe)
 */
export const PAID_PLANS: PlanConfig[] = [
  // ========================================
  // PLAN PRO
  // ========================================
  {
    internal_id: 'pro',
    name: 'Pro',
    description: 'Plan Pro - Idéal pour les équipes en croissance qui ont besoin de fonctionnalités avancées et d\'un support prioritaire',
    type: 'LICENSED',
    active: true,

    prices: [
      {
        lookup_key: 'veridian_pro_monthly_v3',
        amount: 2900, // 29€
        currency: 'eur',
        interval: 'month',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'unspecified'
      },
      {
        lookup_key: 'veridian_pro_yearly_v3',
        amount: 29000, // 290€ (économie de 58€/an)
        currency: 'eur',
        interval: 'year',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'unspecified'
      },
      // Anciennes versions (grandfathering)
      {
        lookup_key: 'veridian_pro_monthly_v2',
        amount: 2900,
        currency: 'eur',
        interval: 'month',
        interval_count: 1,
        trial_period_days: null,
        active: false,
        tax_behavior: 'unspecified'
      },
      {
        lookup_key: 'veridian_pro_yearly_v2',
        amount: 29000,
        currency: 'eur',
        interval: 'year',
        interval_count: 1,
        trial_period_days: null,
        active: false,
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
      features: [
        'Utilisateurs illimités',
        'Twenty CRM avancé',
        'Notifuse sans limite',
        'Workflows automatisés',
        'Support email prioritaire',
        'Analytics avancés'
      ],
      cta_text: 'Souscrire'
    }
  },

  // ========================================
  // PLAN ENTERPRISE
  // ========================================
  {
    internal_id: 'enterprise',
    name: 'Enterprise',
    description: 'Plan Enterprise - Solution complète pour les grandes entreprises avec SSO, SLA garanti et support dédié 24/7',
    type: 'LICENSED',
    active: true,

    prices: [
      {
        lookup_key: 'veridian_enterprise_monthly_v6',
        amount: 4900, // 49€
        currency: 'eur',
        interval: 'month',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'exclusive'
      },
      {
        lookup_key: 'veridian_enterprise_yearly_v6',
        amount: 49000, // 490€ (économie de 2 mois)
        currency: 'eur',
        interval: 'year',
        interval_count: 1,
        trial_period_days: null,
        active: true,
        tax_behavior: 'unspecified'
      },
      // Anciennes versions (grandfathering)
      {
        lookup_key: 'veridian_enterprise_monthly_v5',
        amount: 4900,
        currency: 'eur',
        interval: 'month',
        interval_count: 1,
        trial_period_days: null,
        active: false,
        tax_behavior: 'exclusive'
      },
      {
        lookup_key: 'veridian_enterprise_yearly_v5',
        amount: 49000,
        currency: 'eur',
        interval: 'year',
        interval_count: 1,
        trial_period_days: null,
        active: false,
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
      highlighted: true,
      features: [
        'Tout du plan Pro',
        'Équipes multi-utilisateurs',
        'SSO & SAML',
        'SLA 99.9%',
        'Support dédié 24/7',
        'Onboarding personnalisé',
        'API access illimité'
      ],
      cta_text: 'Souscrire'
    }
  }
];

/**
 * Produits metered WORKFLOW_NODE_EXECUTION (requis par Twenty v1.16.7)
 *
 * Chaque plan (PRO, ENTERPRISE) nécessite un produit metered en plus du BASE_PRODUCT.
 * Twenty v1.16.7 valide que chaque subscription a exactement 2 items:
 * 1 LICENSED (BASE_PRODUCT) + 1 METERED (WORKFLOW_NODE_EXECUTION)
 *
 * Les prix utilisent un tiered pricing à 2 niveaux :
 * - Tier 1 : crédits inclus (flat_amount = 0 pour nous, gratuit)
 * - Tier 2 : surplus facturé au unit_amount_decimal par exécution
 */
export const METERED_PRODUCTS: MeteredProductConfig[] = [
  // ========================================
  // PRO — Workflow Node Execution
  // ========================================
  {
    internal_id: 'pro_workflow',
    name: 'Pro — Workflow Credits',
    description: 'Crédits d\'exécution de workflows pour le plan Pro (10 000/mois inclus)',
    meter_id: WORKFLOW_METER_ID,
    active: true,

    prices: [
      {
        lookup_key: 'veridian_pro_workflow_monthly_v1',
        currency: 'eur',
        interval: 'month',
        included_credits: 10000,
        flat_amount: 0,
        overage_unit_amount_decimal: '100', // 1€ pour 100 exécutions (0.01€/exec)
        active: true,
      },
      {
        lookup_key: 'veridian_pro_workflow_yearly_v1',
        currency: 'eur',
        interval: 'year',
        included_credits: 10000,
        flat_amount: 0,
        overage_unit_amount_decimal: '100',
        active: true,
      },
    ],

    stripe_metadata: {
      planKey: 'PRO',
      priceUsageBased: 'METERED',
      productKey: 'WORKFLOW_NODE_EXECUTION',
    },
  },

  // ========================================
  // ENTERPRISE — Workflow Node Execution
  // ========================================
  {
    internal_id: 'enterprise_workflow',
    name: 'Enterprise — Workflow Credits',
    description: 'Crédits d\'exécution de workflows pour le plan Enterprise (20 000/mois inclus)',
    meter_id: WORKFLOW_METER_ID,
    active: true,

    prices: [
      {
        lookup_key: 'veridian_enterprise_workflow_monthly_v1',
        currency: 'eur',
        interval: 'month',
        included_credits: 20000,
        flat_amount: 0,
        overage_unit_amount_decimal: '80', // 0.008€/exec (moins cher que Pro)
        active: true,
      },
      {
        lookup_key: 'veridian_enterprise_workflow_yearly_v1',
        currency: 'eur',
        interval: 'year',
        included_credits: 20000,
        flat_amount: 0,
        overage_unit_amount_decimal: '80',
        active: true,
      },
    ],

    stripe_metadata: {
      planKey: 'ENTERPRISE',
      priceUsageBased: 'METERED',
      productKey: 'WORKFLOW_NODE_EXECUTION',
    },
  },
];

// ============================================================================
// HELPERS & VALIDATION
// ============================================================================

/**
 * Retourne tous les plans (gratuit + payants + metered)
 */
export function getAllPlans() {
  return {
    free: FREE_PLAN,
    paid: PAID_PLANS,
    metered: METERED_PRODUCTS,
  };
}

/**
 * Récupère un plan par internal_id
 */
export function getPlanByInternalId(internalId: string): PlanConfig | FreePlanConfig | null {
  if (internalId === FREE_PLAN.internal_id) {
    return FREE_PLAN;
  }
  return PAID_PLANS.find(p => p.internal_id === internalId) || null;
}

/**
 * Récupère un prix par lookup_key
 */
export function getPriceByLookupKey(lookupKey: string): { plan: PlanConfig; price: PriceConfig } | null {
  for (const plan of PAID_PLANS) {
    const price = plan.prices.find(p => p.lookup_key === lookupKey);
    if (price) {
      return { plan, price };
    }
  }
  return null;
}

/**
 * Valide la configuration (appelé au build)
 */
export function validateBillingConfig(): void {
  const errors: string[] = [];

  // Vérifier unicité des internal_id (paid + metered)
  const internalIds = new Set<string>();
  [...PAID_PLANS, ...METERED_PRODUCTS].forEach(plan => {
    if (internalIds.has(plan.internal_id)) {
      errors.push(`Duplicate internal_id: ${plan.internal_id}`);
    }
    internalIds.add(plan.internal_id);
  });

  // Vérifier unicité des lookup_key (paid + metered)
  const lookupKeys = new Set<string>();
  PAID_PLANS.forEach(plan => {
    plan.prices.forEach(price => {
      if (lookupKeys.has(price.lookup_key)) {
        errors.push(`Duplicate lookup_key: ${price.lookup_key}`);
      }
      lookupKeys.add(price.lookup_key);
    });
  });
  METERED_PRODUCTS.forEach(product => {
    product.prices.forEach(price => {
      if (lookupKeys.has(price.lookup_key)) {
        errors.push(`Duplicate lookup_key: ${price.lookup_key}`);
      }
      lookupKeys.add(price.lookup_key);
    });
  });

  // Vérifier que chaque plan a au moins un prix actif
  PAID_PLANS.forEach(plan => {
    if (plan.active && !plan.prices.some(p => p.active)) {
      errors.push(`Plan ${plan.internal_id} is active but has no active prices`);
    }
  });

  // Vérifier l'ordre d'affichage (pas de doublons)
  const displayOrders = new Set<number>();
  [FREE_PLAN, ...PAID_PLANS].forEach(plan => {
    const order = plan.ui_metadata.display_order;
    if (displayOrders.has(order)) {
      errors.push(`Duplicate display_order: ${order}`);
    }
    displayOrders.add(order);
  });

  if (errors.length > 0) {
    throw new Error(`Billing config validation failed:\n${errors.join('\n')}`);
  }
}

// Validation automatique au chargement du module
if (process.env.NODE_ENV !== 'test') {
  validateBillingConfig();
}
