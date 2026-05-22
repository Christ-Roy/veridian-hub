// lib/pricing/helpers.ts
//
// API d'accès au catalogue PLANS. Toute consommation du catalogue (page
// /pricing, checkout, webhook Stripe) passe par ces helpers — jamais
// d'import direct du Record `PLANS` pour les lookups.

import { isProduction } from '@/utils/env';

import { PLANS, LEGACY_STRIPE_PRICE_MAPPING, type PlanKey, type Plan, type Interval } from './plans';

/**
 * Lookup par clé. Lance si la clé n'existe pas (programmer error).
 */
export function getPlanByKey(key: PlanKey): Plan {
  const plan = PLANS[key];
  if (!plan) {
    throw new Error(`[pricing] Unknown plan key: ${key}`);
  }
  return plan;
}

/**
 * Lookup safe par string libre (pour les inputs externes — user, webhook).
 * Retourne null si la clé est invalide.
 */
export function tryGetPlanByKey(key: string): Plan | null {
  if (!(key in PLANS)) return null;
  return PLANS[key as PlanKey];
}

/**
 * Lookup par Stripe Price ID. Cherche d'abord dans les `stripePriceId`
 * canoniques des plans, puis fallback sur le LEGACY_STRIPE_PRICE_MAPPING.
 *
 * Utilisé par le webhook Stripe pour mapper un `subscription.items.data[0].price.id`
 * vers une `PlanKey` du catalogue.
 *
 * Retourne null si aucun mapping trouvé (le webhook handler décide quoi faire
 * — typiquement log un warning et garder le plan actuel du tenant).
 */
export function getPlanByStripePriceId(stripePriceId: string): Plan | null {
  // 1. Catalogue canonique — on cherche dans les Price IDs Live ET Test :
  //    le webhook peut tourner en prod (Price ID Live) ou en staging
  //    (Price ID Test), le resolver doit couvrir les deux.
  for (const plan of Object.values(PLANS)) {
    if (
      plan.stripePriceId.month === stripePriceId ||
      plan.stripePriceId.year === stripePriceId ||
      plan.stripePriceIdTest.month === stripePriceId ||
      plan.stripePriceIdTest.year === stripePriceId
    ) {
      return plan;
    }
  }
  // 2. Fallback legacy
  const legacyKey = LEGACY_STRIPE_PRICE_MAPPING[stripePriceId];
  if (legacyKey) {
    return PLANS[legacyKey];
  }
  return null;
}

/**
 * Détermine si une transition de plan est un upgrade ou un downgrade
 * en comparant les `rank`.
 */
export function comparePlanRank(from: PlanKey, to: PlanKey): 'upgrade' | 'downgrade' | 'same' {
  const fromRank = PLANS[from].rank;
  const toRank = PLANS[to].rank;
  if (toRank > fromRank) return 'upgrade';
  if (toRank < fromRank) return 'downgrade';
  return 'same';
}

/**
 * Pour le checkout : retourne le Stripe Price ID à utiliser pour une plan key
 * + un interval. Throw si :
 *  - la clé n'existe pas
 *  - le plan n'a pas de Stripe Price ID configuré (placeholder ou plan offert)
 *
 * 🔑 Résolution Live vs Test : en production le checkout utilise une clé
 * Stripe LIVE (cf utils/env.ts:getStripeKey) — il DOIT donc utiliser un
 * Price ID LIVE. Hors prod (staging, local), clé TEST → Price ID TEST.
 * Un Price ID Live avec une clé Test (ou l'inverse) = erreur Stripe
 * "No such price". On aligne le Price ID sur le même environnement que
 * la clé. Cette fonction est appelée server-side (route /api/billing/
 * checkout, runtime nodejs) où `isProduction()` lit un DOMAIN fiable.
 *
 * Cette erreur est visible côté admin Hub car le bouton "Choisir Pro" du UI
 * appelle cette fonction au moment du clic.
 */
export function getStripePriceIdForCheckout(key: PlanKey, interval: Interval): string {
  const plan = getPlanByKey(key);
  const useLive = isProduction();
  const priceId = useLive
    ? plan.stripePriceId[interval]
    : plan.stripePriceIdTest[interval];
  if (!priceId) {
    const envLabel = useLive ? 'Live' : 'Test';
    throw new Error(
      `[pricing] Plan "${key}" has no Stripe Price ID ${envLabel} for interval "${interval}". ` +
        `Run scripts/admin/setup-stripe-prices.ts --mode=${useLive ? 'live' : 'test'} to provision them.`,
    );
  }
  return priceId;
}

/**
 * Pour la page /pricing : groupe les plans publics par "section" pour affichage.
 * Sections : "bundles" (Veridian X), "notifuse" (à la carte), "prospection" (à la carte).
 *
 * Le free de chaque app est groupé dans la section app à la carte.
 */
export function getPublicPricingSections(): {
  bundles: Plan[];
  notifuse: Plan[];
  prospection: Plan[];
} {
  const all = Object.values(PLANS).filter((p) => !p.hidden_from_public);
  return {
    bundles: all
      .filter((p) => p.apps.length > 1)
      .sort((a, b) => a.rank - b.rank),
    notifuse: all
      .filter((p) => p.apps.length === 1 && p.apps[0] === 'notifuse')
      .sort((a, b) => a.rank - b.rank),
    prospection: all
      .filter((p) => p.apps.length === 1 && p.apps[0] === 'prospection')
      .sort((a, b) => a.rank - b.rank),
  };
}

/**
 * Plans qu'on doit propager aux apps downstream quand le user souscrit à
 * `key`. Pour un plan à la carte, c'est juste lui-même. Pour un bundle, c'est
 * la décomposition.
 *
 * Utilisé par le webhook Stripe pour appeler `update-plan` sur les bonnes
 * apps. Cf docs/CONTRAT-HUB.md §7.4 (chaîne Stripe → Hub → apps).
 */
export function getAppPlansForBundle(key: PlanKey): Array<{ app: 'notifuse' | 'prospection'; plan: PlanKey }> {
  const plan = getPlanByKey(key);
  const result: Array<{ app: 'notifuse' | 'prospection'; plan: PlanKey }> = [];

  if (plan.apps.includes('notifuse')) {
    // Mappe le bundle vers le plan Notifuse équivalent
    const notifusePlan: PlanKey =
      key === 'veridian-pro' ? 'notifuse-pro' :
      key === 'veridian-business' ? 'notifuse-business' :
      key === 'lifetime-site-vitrine' ? 'notifuse-pro' :
      key === 'lifetime-partner' ? 'notifuse-business' :
      key === 'internal' ? 'notifuse-business' :
      key; // sinon c'est déjà un plan Notifuse à la carte
    result.push({ app: 'notifuse', plan: notifusePlan });
  }

  if (plan.apps.includes('prospection')) {
    const prospectionPlan: PlanKey =
      key === 'veridian-pro' ? 'prospection-pro' :
      key === 'veridian-business' ? 'prospection-enterprise' :
      key === 'lifetime-site-vitrine' ? 'prospection-pro' :
      key === 'lifetime-partner' ? 'prospection-enterprise' :
      key === 'internal' ? 'prospection-enterprise' :
      key;
    result.push({ app: 'prospection', plan: prospectionPlan });
  }

  return result;
}

/**
 * Construit l'URL de checkout côté front pour un plan + interval.
 * Le front POST ensuite vers /api/billing/checkout qui crée la session Stripe.
 */
export function buildCheckoutUrl(key: PlanKey, interval: Interval, redirectAfter?: string): string {
  const params = new URLSearchParams({ plan: key, interval });
  if (redirectAfter) params.set('redirect', redirectAfter);
  return `/api/billing/checkout?${params.toString()}`;
}
