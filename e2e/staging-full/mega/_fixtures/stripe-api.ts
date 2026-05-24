/**
 * MEGA fixture — `stripe-api.ts`
 *
 * Wrapper Stripe SDK preprod pour les opérations de cleanup et de
 * simulation d'events :
 *
 *   - `listMegaCustomers()` : list customers test matching prefix email
 *   - `cancelAllSubsForCustomer(customerId)` : cancel toutes subs actives
 *   - `deleteCustomerSafe(customerId)` : marque customer 'deleted' (Stripe
 *     ne permet pas le hard-delete, mais marque pour analytics)
 *   - `cleanupAllMegaArtifacts()` : enchaîne list + cancel + delete pour
 *     toute la suite MEGA, appelé par `globalTeardown`
 *
 * **PRÉ-REQUIS** :
 *   - `STRIPE_SECRET_KEY_TEST` exporté (auto-sourcé par `scripts/e2e/mega.sh`
 *     depuis `~/credentials/.all-creds.env`)
 *   - Pas de clé LIVE jamais utilisée ici — triple garde-fou regex
 *
 * **GARDE-FOUS** :
 *   1. Refuse si la clé ne commence pas par `sk_test_` (anti-LIVE strict)
 *   2. Refuse si la clé est fake/placeholder (sk_test_fake, sk_test_xxx)
 *   3. Tous les filtres email matchent strictement `e2e-mega-*@e2e.veridian.site`
 *
 * **PERF** : Stripe API rate-limit ≈ 100 req/sec en TEST. Le cleanup
 * batche jusqu'à 100 customers par call list — suffisant pour 30+ runs
 * concurrents.
 */
import Stripe from 'stripe';

import { MEGA_EMAIL_DOMAIN, MEGA_EMAIL_PREFIX } from './run-stamp';

/**
 * Erreur typée pour distinguer un fail de config (clé absente) d'un
 * fail métier (Stripe API down). Permet au caller de décider :
 * fail-hard (config absent = bug) vs fail-soft (Stripe down = skip cleanup).
 */
export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

/**
 * Singleton SDK Stripe initialisé lazy au premier appel. Évite de
 * crash le module au load si STRIPE_SECRET_KEY_TEST n'est pas encore
 * exporté (race conditions au boot Playwright).
 */
let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (stripeInstance) return stripeInstance;

  const key = process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || '';

  // ─── Garde-fou 1 : clé doit être TEST ────────────────────────────
  if (!key.startsWith('sk_test_')) {
    throw new StripeConfigError(
      `[mega/stripe-api] STRIPE_SECRET_KEY_TEST manquante ou en mode LIVE. ` +
        `Clé doit commencer par sk_test_ (anti-LIVE strict). ` +
        `Source les creds : source ~/credentials/.all-creds.env`,
    );
  }

  // ─── Garde-fou 2 : refus des clés fake/placeholder ───────────────
  // Les clés fake type sk_test_fake / sk_test_xxx / sk_test_dummy ne
  // valent rien et causent des 401 silencieux. On préfère fail-fast.
  if (/^sk_test_(fake|xxx+|dummy|placeholder|example)/i.test(key)) {
    throw new StripeConfigError(
      `[mega/stripe-api] STRIPE_SECRET_KEY_TEST ressemble à un placeholder (${key.slice(0, 16)}...). ` +
        `Source la vraie clé depuis ~/credentials/.all-creds.env`,
    );
  }

  stripeInstance = new Stripe(key, {
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    typescript: true,
    maxNetworkRetries: 2,
  });
  return stripeInstance;
}

/**
 * Liste tous les customers Stripe test matching le préfixe MEGA.
 *
 * Filtre côté client (Stripe `customers.list` ne supporte pas LIKE) :
 * on récupère par batch de 100 et on filtre email starts_with
 * `e2e-mega-`. Acceptable pour < 1000 customers totaux.
 *
 * @param maxBatches limite de batches (1 batch = 100 customers).
 *   Défaut 5 (= jusqu'à 500 customers scannés). Augmente si la suite
 *   a tourné beaucoup et qu'on suspecte un gros résidu.
 */
export async function listMegaCustomers(
  maxBatches = 5,
): Promise<Stripe.Customer[]> {
  const stripe = getStripe();
  const matches: Stripe.Customer[] = [];
  let starting_after: string | undefined;

  for (let batch = 0; batch < maxBatches; batch++) {
    const page = await stripe.customers.list({
      limit: 100,
      starting_after,
    });
    for (const c of page.data) {
      if (c.email && c.email.startsWith(MEGA_EMAIL_PREFIX) && c.email.endsWith(MEGA_EMAIL_DOMAIN)) {
        matches.push(c);
      }
    }
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1]?.id;
    if (!starting_after) break;
  }

  return matches;
}

/**
 * Cancel toutes les subscriptions actives d'un customer (sans wait
 * end of period). Idempotent (skip celles déjà canceled).
 *
 * Retourne le nombre de subs canceled.
 */
export async function cancelAllSubsForCustomer(customerId: string): Promise<number> {
  const stripe = getStripe();
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  let canceled = 0;
  for (const sub of subs.data) {
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      continue;
    }
    try {
      await stripe.subscriptions.cancel(sub.id);
      canceled++;
    } catch (err) {
      // Sub peut être en état intermédiaire (incomplete), Stripe refuse.
      // On log mais on ne fail pas tout le cleanup.

      console.warn(
        `[mega/stripe-api] cancel sub ${sub.id} (customer ${customerId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return canceled;
}

/**
 * Marque un customer Stripe comme 'deleted'. Stripe ne permet pas le
 * hard-delete en TEST mode pour préserver l'audit, mais le marque
 * comme deleted (n'apparaît plus dans les listings non-archivés).
 *
 * Idempotent : skip si déjà deleted.
 */
export async function deleteCustomerSafe(customerId: string): Promise<boolean> {
  const stripe = getStripe();
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return false;
    await stripe.customers.del(customerId);
    return true;
  } catch (err) {
    // Customer peut avoir été supprimé entre temps par un autre worker
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing') {
      return false;
    }
    throw err;
  }
}

/**
 * Cleanup complet de tous les artifacts Stripe MEGA d'un coup.
 * Appelé par `globalTeardown`. Idempotent + safe à relancer.
 *
 * Retour : statistiques pour log/audit.
 */
export interface MegaStripeCleanupStats {
  customersFound: number;
  subsCanceled: number;
  customersDeleted: number;
  errors: string[];
}

export async function cleanupAllMegaArtifacts(): Promise<MegaStripeCleanupStats> {
  const stats: MegaStripeCleanupStats = {
    customersFound: 0,
    subsCanceled: 0,
    customersDeleted: 0,
    errors: [],
  };

  let customers: Stripe.Customer[];
  try {
    customers = await listMegaCustomers(10); // scan jusqu'à 1000
  } catch (err) {
    stats.errors.push(`list customers failed: ${err instanceof Error ? err.message : String(err)}`);
    return stats;
  }
  stats.customersFound = customers.length;

  for (const c of customers) {
    try {
      stats.subsCanceled += await cancelAllSubsForCustomer(c.id);
    } catch (err) {
      stats.errors.push(
        `cancel subs ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const deleted = await deleteCustomerSafe(c.id);
      if (deleted) stats.customersDeleted++;
    } catch (err) {
      stats.errors.push(
        `delete customer ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return stats;
}

/**
 * Helper pour les specs qui veulent vérifier l'existence d'un sub
 * Stripe précis après checkout (pattern : `c.email = X → list subs →
 * assert 1 sub avec price Y`).
 */
export async function getCustomerByEmail(email: string): Promise<Stripe.Customer | null> {
  const stripe = getStripe();
  const list = await stripe.customers.list({ email, limit: 1 });
  return list.data[0] ?? null;
}

/**
 * Liste les subs d'un customer (pour assertions billing).
 */
export async function listSubsForCustomer(customerId: string): Promise<Stripe.Subscription[]> {
  const stripe = getStripe();
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  return subs.data;
}

/**
 * Expose le SDK Stripe brut pour les cas avancés (replay event,
 * trigger CLI). À utiliser avec parcimonie — préférer les helpers
 * ci-dessus quand possible.
 */
export function getStripeSdk(): Stripe {
  return getStripe();
}
