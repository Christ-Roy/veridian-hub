/**
 * UTILITAIRE DE DÉTECTION D'ENVIRONNEMENT
 *
 * Détection basée sur le DOMAIN (dev.veridian.site vs app.veridian.site)
 * Plus fiable que NODE_ENV ou les priorités de variables
 */

export type Environment = 'development' | 'production';

/**
 * Détecte l'environnement actuel basé sur le domaine
 */
export function getEnvironment(): Environment {
  const domain = process.env.DOMAIN || process.env.NEXT_PUBLIC_DOMAIN || process.env.NEXT_PUBLIC_SITE_URL || '';

  // Priorité au DOMAIN explicite
  if (domain.includes('dev.veridian.site') || domain.includes('staging.veridian.site') || domain.includes('localhost')) {
    return 'development';
  }

  if (domain.includes('app.veridian.site')) {
    return 'production';
  }

  // Fallback: utiliser NODE_ENV
  if (process.env.NODE_ENV === 'production') {
    return 'production';
  }

  return 'development';
}

/**
 * Vérifie si on est en environnement de production
 */
export function isProduction(): boolean {
  return getEnvironment() === 'production';
}

/**
 * Vérifie si on est en environnement de développement
 */
export function isDevelopment(): boolean {
  return getEnvironment() === 'development';
}

/**
 * Retourne le label de l'environnement pour les logs
 */
export function getEnvironmentLabel(): string {
  return isProduction() ? 'PRODUCTION' : 'DEVELOPMENT';
}

/**
 * Retourne la clé Stripe appropriée basée sur l'environnement
 */
export function getStripeKey(): string {
  const prodKey = process.env.STRIPE_SECRET_KEY_LIVE;
  const testKey = process.env.STRIPE_SECRET_KEY;

  const key = isProduction() ? prodKey : testKey;

  if (!key) {
    throw new Error(
      `Clé Stripe non trouvée pour l'environnement ${getEnvironmentLabel()} ` +
      `(domain: ${process.env.DOMAIN || 'non défini'})`
    );
  }

  return key;
}

/**
 * Retourne le secret webhook Stripe approprié basé sur l'environnement
 */
export function getStripeWebhookSecret(): string {
  const prodSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const secret = isProduction() ? prodSecret : testSecret;

  if (!secret) {
    throw new Error(
      `Secret webhook Stripe non trouvé pour l'environnement ${getEnvironmentLabel()} ` +
      `(domain: ${process.env.DOMAIN || 'non défini'})`
    );
  }

  return secret;
}

/**
 * Retourne la clé publishable Stripe appropriée (client-side)
 */
export function getStripePublishableKey(): string {
  const prodKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE;
  const testKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  const key = isProduction() ? prodKey : testKey;

  if (!key) {
    throw new Error(
      `Clé publishable Stripe non trouvée pour l'environnement ${getEnvironmentLabel()} ` +
      `(domain: ${process.env.DOMAIN || 'non défini'})`
    );
  }

  return key;
}
