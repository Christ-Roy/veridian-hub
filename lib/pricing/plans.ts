// lib/pricing/plans.ts
//
// 🔥 SOURCE DE VÉRITÉ DU CATALOGUE PRICING VERIDIAN.
//
// Stripe reste source de vérité pour l'ÉTAT des subscriptions (active/canceled,
// trial_end, current_period_end). Le CATALOGUE des plans et leurs prix marketing
// vit ici, dans le code, versionné, testé.
//
// Cf docs/CONTRAT-HUB.md §3 (Plans Veridian — matrice cross-app).
//
// 🚧 PRIX PLACEHOLDERS : les chiffres ci-dessous sont des targets à valider avec
// Robert. Tout `price_eur: TODO_*` doit être remplacé par une vraie valeur avant
// d'ouvrir le checkout au public. Les `stripePriceId: null` doivent être
// remplacés par les Price IDs créés dans Stripe (via le script
// `scripts/admin/setup-stripe-prices.ts` à venir).

export type PlanKey =
  // Plans Notifuse à la carte
  | 'notifuse-free'
  | 'notifuse-pro'
  | 'notifuse-business'
  // Plans Prospection à la carte
  | 'prospection-free'
  | 'prospection-pro'
  | 'prospection-enterprise'
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
  /** Nom affiché côté UI marketing. */
  name: string;
  /** Sous-titre court (1 phrase, FR). */
  tagline: string;
  /** Prix mensuel EUR HT. 0 = gratuit. */
  price_eur: number;
  /** Prix annuel EUR HT (par mois facturé annuellement). null = pas d'option annuelle. */
  price_eur_yearly_per_month: number | null;
  /** Stripe Price ID — null = pas de checkout Stripe (plan offert ou freemium). */
  stripePriceId: {
    month: string | null;
    year: string | null;
  };
  /** Apps débloquées par ce plan. */
  apps: ('notifuse' | 'prospection')[];
  /**
   * 🔥 v1.3 — Quota seats CROSS-APP. Le owner compte pour 1.
   * Un seat = 1 user humain qui peut accéder à TOUTES les apps souscrites
   * par ce tenant (cf §3.5 contrat). Membres invités via Hub
   * `/api/admin/tenants/<id>/invite-member`.
   */
  members_seats: number | 'unlimited';
  /** Quotas par app pour ce plan (members_max ici = info app-locale, le vrai
   *  quota cross-app est members_seats ci-dessus). */
  quotas: AppQuotas;
  /** Features affichées sur la page pricing (FR). */
  features: PlanFeature[];
  /** Tier de comparaison (0=free, 1=starter, 2=pro, 3=enterprise, 99=lifetime/internal). */
  rank: number;
  /** Si true, affiché en hero / "Recommandé". */
  recommended?: boolean;
  /** Si true, plan n'apparaît pas sur la page /pricing publique (offert/interne). */
  hidden_from_public?: boolean;
  /** Cf §3.3 contrat — détermine l'immunité face aux downgrades Stripe. */
  plan_source: 'stripe' | 'manual' | 'lifetime_site_vitrine' | 'lifetime_partner' | 'internal';
}

/**
 * 🔥 v1.3 — Métadonnées par APP (pas par plan). Détermine l'affichage Hub
 * Dashboard (self-serve vs shadow marketing) et le routing CTA.
 */
export interface AppMetadata {
  key: VeridianApp;
  display_name: string;
  /** True si l'app est accessible self-serve via signup Hub + checkout Stripe. */
  self_serve: boolean;
  /**
   * True si l'app est réservée aux clients ayant acheté un site vitrine
   * Veridian (lifetime_site_vitrine). Affichée grisée dans le dashboard
   * pour les autres tenants. Cf §3.6 + §8.9 contrat.
   */
  client_only: boolean;
  /** Tagline courte pour la card Dashboard. */
  tagline: string;
  /** Emoji icon. */
  icon: string;
  /** URL marketing pour CTA shadow (si client_only). */
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
    marketing_url: 'https://veridian.site/sites',
  },
  cms: {
    key: 'cms',
    display_name: 'Veridian CMS',
    self_serve: false,
    client_only: true,
    tagline: 'CMS multi-tenant (Payload) pour vos sites',
    icon: '📝',
    marketing_url: 'https://veridian.site/sites',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CATALOGUE
// ─────────────────────────────────────────────────────────────────────────────

export const PLANS: Record<PlanKey, Plan> = {
  // ────── Notifuse ──────
  'notifuse-free': {
    key: 'notifuse-free',
    name: 'Notifuse Free',
    tagline: 'Tester les emails transactionnels Veridian',
    price_eur: 0,
    price_eur_yearly_per_month: null,
    stripePriceId: { month: null, year: null },
    apps: ['notifuse'],
    members_seats: 1, // §3.5 : free = solo
    quotas: {
      notifuse: { emails_per_month: 1_000, members_max: 1 },
    },
    features: [
      { label: '1 000 emails par mois', included: true },
      { label: '1 membre', included: true },
      { label: 'Templates MJML', included: true },
      { label: 'Analytics avancés', included: false },
      { label: 'Support prioritaire', included: false },
    ],
    rank: 0,
    plan_source: 'stripe',
  },

  'notifuse-pro': {
    key: 'notifuse-pro',
    name: 'Notifuse Pro',
    tagline: 'Pour scaler vos campagnes transactionnelles',
    price_eur: 19, // 🚧 TODO_PRICE — valider avec Robert
    price_eur_yearly_per_month: 16, // 🚧 TODO_PRICE — -15 % standard SaaS
    stripePriceId: { month: null, year: null }, // 🚧 TODO_STRIPE
    apps: ['notifuse'],
    members_seats: 5, // §3.5 : pro = 5 seats
    quotas: {
      notifuse: { emails_per_month: 50_000, members_max: 5 },
    },
    features: [
      { label: '50 000 emails par mois', included: true },
      { label: '5 membres', included: true },
      { label: 'Templates MJML', included: true },
      { label: 'Analytics avancés', included: true },
      { label: 'Support prioritaire', included: false },
    ],
    rank: 2,
    plan_source: 'stripe',
  },

  'notifuse-business': {
    key: 'notifuse-business',
    name: 'Notifuse Business',
    tagline: 'Volume illimité, support prioritaire',
    price_eur: 49, // 🚧 TODO_PRICE
    price_eur_yearly_per_month: 41, // 🚧 TODO_PRICE
    stripePriceId: { month: null, year: null }, // 🚧 TODO_STRIPE
    apps: ['notifuse'],
    members_seats: 25, // §3.5 : business = 25 seats
    quotas: {
      notifuse: { emails_per_month: 500_000, members_max: 'unlimited' },
    },
    features: [
      { label: '500 000 emails par mois', included: true },
      { label: 'Membres illimités', included: true },
      { label: 'Templates MJML', included: true },
      { label: 'Analytics avancés', included: true },
      { label: 'Support prioritaire', included: true },
    ],
    rank: 3,
    plan_source: 'stripe',
  },

  // ────── Prospection ──────
  'prospection-free': {
    key: 'prospection-free',
    name: 'Prospection Free',
    tagline: 'Tester la qualification de leads .fr',
    price_eur: 0,
    price_eur_yearly_per_month: null,
    stripePriceId: { month: null, year: null },
    apps: ['prospection'],
    members_seats: 1,
    quotas: {
      prospection: { leads_total: 300, members_max: 1 },
    },
    features: [
      { label: '300 prospects visibles', included: true },
      { label: '1 membre', included: true },
      { label: 'Filtres de base', included: true },
      { label: 'Export CSV', included: false },
      { label: 'Téléphonie SIP intégrée', included: false },
    ],
    rank: 0,
    plan_source: 'stripe',
  },

  'prospection-pro': {
    key: 'prospection-pro',
    name: 'Prospection Pro',
    tagline: 'Pour les commerciaux indépendants',
    price_eur: 29, // 🚧 TODO_PRICE
    price_eur_yearly_per_month: 24, // 🚧 TODO_PRICE
    stripePriceId: { month: null, year: null }, // 🚧 TODO_STRIPE
    apps: ['prospection'],
    members_seats: 5,
    quotas: {
      prospection: { leads_total: 100_000, members_max: 5 },
    },
    features: [
      { label: '100 000 prospects', included: true },
      { label: '5 membres', included: true },
      { label: 'Filtres avancés + export CSV', included: true },
      { label: 'Pipeline Kanban', included: true },
      { label: 'Téléphonie SIP intégrée', included: false },
    ],
    rank: 2,
    plan_source: 'stripe',
  },

  'prospection-enterprise': {
    key: 'prospection-enterprise',
    name: 'Prospection Enterprise',
    tagline: 'Pour les équipes de vente structurées',
    price_eur: 49, // 🚧 TODO_PRICE
    price_eur_yearly_per_month: 41, // 🚧 TODO_PRICE
    stripePriceId: { month: null, year: null }, // 🚧 TODO_STRIPE
    apps: ['prospection'],
    members_seats: 25,
    quotas: {
      prospection: { leads_total: 500_000, members_max: 'unlimited' },
    },
    features: [
      { label: '500 000 prospects', included: true },
      { label: 'Membres illimités', included: true },
      { label: 'Filtres avancés + export CSV', included: true },
      { label: 'Pipeline Kanban', included: true },
      { label: 'Téléphonie SIP intégrée', included: true },
    ],
    rank: 3,
    plan_source: 'stripe',
  },

  // ────── Bundles ──────
  'veridian-pro': {
    key: 'veridian-pro',
    name: 'Veridian Pro',
    tagline: 'Notifuse Pro + Prospection Pro avec remise',
    // 19 + 29 = 48 → bundle 39 (-19 %)
    price_eur: 39, // 🚧 TODO_PRICE — valider la dégression
    price_eur_yearly_per_month: 33, // 🚧 TODO_PRICE
    stripePriceId: { month: null, year: null }, // 🚧 TODO_STRIPE
    apps: ['notifuse', 'prospection'],
    members_seats: 5,
    quotas: {
      notifuse: { emails_per_month: 50_000, members_max: 5 },
      prospection: { leads_total: 100_000, members_max: 5 },
    },
    features: [
      { label: 'Notifuse Pro inclus (50k emails/mois)', included: true },
      { label: 'Prospection Pro inclus (100k prospects)', included: true },
      { label: '5 membres cross-app', included: true },
      { label: 'Économie de 9 €/mois vs à la carte', included: true },
      { label: 'Support prioritaire', included: false },
    ],
    rank: 2,
    recommended: true,
    plan_source: 'stripe',
  },

  'veridian-business': {
    key: 'veridian-business',
    name: 'Veridian Business',
    tagline: 'Tout Veridian, volumes illimités',
    // 49 + 49 = 98 → bundle 79 (-19 %)
    price_eur: 79, // 🚧 TODO_PRICE
    price_eur_yearly_per_month: 66, // 🚧 TODO_PRICE
    stripePriceId: { month: null, year: null }, // 🚧 TODO_STRIPE
    apps: ['notifuse', 'prospection'],
    members_seats: 25,
    quotas: {
      notifuse: { emails_per_month: 500_000, members_max: 'unlimited' },
      prospection: { leads_total: 500_000, members_max: 'unlimited' },
    },
    features: [
      { label: 'Notifuse Business inclus (500k emails/mois)', included: true },
      { label: 'Prospection Enterprise inclus (500k prospects)', included: true },
      { label: '25 membres cross-app', included: true },
      { label: 'Support prioritaire', included: true },
      { label: 'SLA 99,9 % uptime', included: true },
    ],
    rank: 3,
    plan_source: 'stripe',
  },

  // ────── Plans offerts (manuels, jamais sur Stripe) ──────
  // Cf §3.3 contrat. Affichés dans l'admin, jamais sur /pricing publique.
  'lifetime-site-vitrine': {
    key: 'lifetime-site-vitrine',
    name: 'Lifetime Site Vitrine',
    tagline: "Inclus à vie avec l'achat d'un site vitrine Veridian",
    price_eur: 0,
    price_eur_yearly_per_month: null,
    stripePriceId: { month: null, year: null },
    apps: ['notifuse', 'prospection'],
    members_seats: 5, // équivalent pro
    quotas: {
      notifuse: { emails_per_month: 50_000, members_max: 5 },
      prospection: { leads_total: 100_000, members_max: 5 },
    },
    features: [
      { label: 'Équivalent Veridian Pro à vie', included: true },
      { label: 'Offert dans la vente du site vitrine', included: true },
    ],
    rank: 99,
    hidden_from_public: true,
    plan_source: 'lifetime_site_vitrine',
  },

  'lifetime-partner': {
    key: 'lifetime-partner',
    name: 'Lifetime Partner',
    tagline: 'Partenaire bizdev Veridian',
    price_eur: 0,
    price_eur_yearly_per_month: null,
    stripePriceId: { month: null, year: null },
    apps: ['notifuse', 'prospection'],
    members_seats: 25, // équivalent business
    quotas: {
      notifuse: { emails_per_month: 500_000, members_max: 'unlimited' },
      prospection: { leads_total: 500_000, members_max: 'unlimited' },
    },
    features: [
      { label: 'Équivalent Veridian Business', included: true },
      { label: 'Accord partenariat', included: true },
    ],
    rank: 99,
    hidden_from_public: true,
    plan_source: 'lifetime_partner',
  },

  'internal': {
    key: 'internal',
    name: 'Internal',
    tagline: 'Comptes internes Veridian (démo, E2E, support)',
    price_eur: 0,
    price_eur_yearly_per_month: null,
    stripePriceId: { month: null, year: null },
    apps: ['notifuse', 'prospection'],
    members_seats: 'unlimited',
    quotas: {
      notifuse: { emails_per_month: 'unlimited', members_max: 'unlimited' },
      prospection: { leads_total: 'unlimited', members_max: 'unlimited' },
    },
    features: [
      { label: 'Quotas illimités', included: true },
      { label: 'Réservé Veridian interne', included: true },
    ],
    rank: 99,
    hidden_from_public: true,
    plan_source: 'internal',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING LEGACY — pour ne pas casser les subscriptions Stripe actives en prod
// ─────────────────────────────────────────────────────────────────────────────
//
// Les `stripe_price_id` ci-dessous sont les anciens IDs Stripe qui correspondent
// aux subscriptions actives en prod aujourd'hui (audit du 2026-05-18 : 4
// products dont 2 utilisés). Quand le webhook Stripe arrive avec ces IDs,
// on les mappe vers les nouveaux `PlanKey`.
//
// 🚧 À remplir avec les vrais price IDs prod via :
//   stripe prices list --limit 20 --active
//
// Quand ces price IDs n'existent plus côté Stripe (clients tous migrés), virer.

export const LEGACY_STRIPE_PRICE_MAPPING: Record<string, PlanKey> = {
  // 'price_1ABC123': 'prospection-pro',
  // 'price_1DEF456': 'prospection-enterprise',
  // À compléter à la prochaine session avec Stripe Dashboard
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
