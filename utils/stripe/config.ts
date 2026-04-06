import Stripe from 'stripe';
import { getStripeKey, getEnvironmentLabel, isProduction } from '@/utils/env';

// Lazy initialization avec Proxy pour compatibilité Docker
// Les variables d'environnement sont injectées au runtime, pas au build time
let _stripeInstance: Stripe | null = null;

function getStripeInstance(): Stripe {
  if (!_stripeInstance) {
    const environmentLabel = getEnvironmentLabel();
    const domain = process.env.DOMAIN || process.env.NEXT_PUBLIC_DOMAIN || 'localhost';

    console.log(`[Stripe Init] Environment: ${environmentLabel}`);
    console.log(`[Stripe Init] Domain: ${domain}`);

    const key = getStripeKey();

    console.log(`[Stripe Init] Mode: ${isProduction() ? 'LIVE' : 'TEST'}`);
    console.log(`[Stripe Init] Key prefix: ${key.substring(0, 15)}...`);

    _stripeInstance = new Stripe(key, {
      apiVersion: '2024-12-18.acacia' as any,
      appInfo: {
        name: 'Veridian SaaS Platform',
        version: '1.0.0',
        url: isProduction() ? 'https://app.veridian.site' : 'https://dev.veridian.site'
      }
    });
  }

  return _stripeInstance;
}

// Export avec Proxy pour intercepter tous les accès et initialiser au runtime
export const stripe = new Proxy({} as Stripe, {
  get(target, prop) {
    const instance = getStripeInstance();
    const value = (instance as any)[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});
