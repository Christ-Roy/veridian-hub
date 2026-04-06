import { loadStripe, Stripe } from '@stripe/stripe-js';
import { getStripePublishableKey, getEnvironmentLabel, isProduction } from '@/utils/env';

let stripePromise: Promise<Stripe | null>;
let cachedKey: string | null = null;

export const getStripe = async () => {
  if (!stripePromise) {
    let key: string;

    // Essayer d'abord les variables d'environnement (build time)
    let envKey: string | null = null;
    try {
      envKey = getStripePublishableKey();
    } catch {
      // getStripePublishableKey() throws if key not found — fallback to /api/config
    }

    if (envKey) {
      key = envKey;
      console.log(`[Stripe Client] Environment: ${getEnvironmentLabel()}`);
      console.log(`[Stripe Client] Using env key: ${key.substring(0, 10)}...`);
    } else {
      // Fallback : utiliser l'API /api/config pour obtenir la clé au runtime
      try {
        const response = await fetch('/api/config');
        if (response.ok) {
          const config = await response.json();
          key = isProduction()
            ? (config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE || config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
            : config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
          console.log('[Stripe Client] Using API key:', key.substring(0, 10) + '...');
        } else {
          throw new Error('Failed to fetch config');
        }
      } catch (e) {
        console.error('[Stripe Client] Error fetching config:', e);
        return null;
      }
    }

    if (!key) {
      console.error('[Stripe Client] No publishable key found!');
      return null;
    }

    stripePromise = loadStripe(key);
  }

  return stripePromise;
};
