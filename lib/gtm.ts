/**
 * Google Tag Manager / GA4 Tracking Utilities
 *
 * Respecte les événements standard GA4 pour une analyse optimale
 * Documentation: https://developers.google.com/analytics/devguides/collection/ga4/reference/events
 */

declare global {
  interface Window {
    dataLayer: any[];
  }
}

/**
 * Push un événement personnalisé vers GTM dataLayer
 *
 * @param event - Nom de l'événement (utiliser les noms GA4 standard)
 * @param data - Données additionnelles
 */
export function trackEvent(event: string, data?: Record<string, any>) {
  if (typeof window === 'undefined') {
    console.warn('[GTM] ❌ SSR - Skipping event:', event);
    return; // SSR - pas de window
  }

  if (!window.dataLayer) {
    console.error('[GTM] ❌ dataLayer non initialisé. Événement NON TRACKÉ:', event, data);
    return;
  }

  const eventData = {
    event,
    timestamp: new Date().toISOString(),
    page_url: window.location.href,
    page_path: window.location.pathname,
    ...data
  };

  console.log('[GTM] ✅ Tracking event:', event, eventData);
  window.dataLayer.push(eventData);

  // Vérifier que l'événement a bien été pushé
  if (process.env.NODE_ENV === 'development') {
    const pushed = window.dataLayer[window.dataLayer.length - 1];
    if (pushed?.event === event) {
      console.log('[GTM] ✅ Event pushed to dataLayer successfully');
    } else {
      console.error('[GTM] ❌ Event push verification failed!');
    }
  }
}

// =============================================================================
// ÉVÉNEMENTS AUTHENTIFICATION (Tunnel de conversion principal)
// =============================================================================

/**
 * Track Sign Up Success (Action la plus importante pour un SaaS)
 *
 * Événement GA4 standard: sign_up
 * https://developers.google.com/analytics/devguides/collection/ga4/reference/events#sign_up
 *
 * @param method - Méthode d'inscription ('email' ou 'google')
 */
export function trackSignUp(method: 'email' | 'google') {
  trackEvent('sign_up', {
    method: method, // Permet de savoir si les gens préfèrent Google ou Email
  });
}

/**
 * Track Login Success
 *
 * Événement GA4 standard: login
 * https://developers.google.com/analytics/devguides/collection/ga4/reference/events#login
 *
 * @param method - Méthode de connexion ('email' ou 'google')
 */
export function trackLogin(method: 'email' | 'google') {
  trackEvent('login', {
    method: method,
  });
}

// =============================================================================
// ÉVÉNEMENTS E-COMMERCE (Tracking revenus Stripe)
// =============================================================================

/**
 * Track Begin Checkout (L'utilisateur clique pour payer)
 *
 * Événement GA4 standard: begin_checkout
 * https://developers.google.com/analytics/devguides/collection/ga4/reference/events#begin_checkout
 *
 * @param planId - ID du plan (ex: 'pro', 'enterprise')
 * @param price - Prix en EUR
 * @param planName - Nom du plan (optionnel)
 */
export function trackBeginCheckout(planId: string, price: number, planName?: string) {
  trackEvent('begin_checkout', {
    currency: 'EUR',
    value: price,
    items: [{
      item_id: planId,
      item_name: planName || `Plan ${planId}`,
      price: price,
      quantity: 1,
      item_category: 'subscription' // Catégorie pour analytics
    }]
  });
}

/**
 * Track Purchase Success (Paiement Stripe confirmé)
 *
 * Événement GA4 standard: purchase
 * https://developers.google.com/analytics/devguides/collection/ga4/reference/events#purchase
 *
 * IMPORTANT: À appeler depuis le webhook Stripe ou la page de confirmation
 *
 * @param transactionId - ID de transaction Stripe (session_id ou payment_intent_id)
 * @param amount - Montant total payé en EUR
 * @param planId - ID du plan souscrit
 * @param planName - Nom du plan
 */
export function trackPurchase(
  transactionId: string,
  amount: number,
  planId?: string,
  planName?: string
) {
  trackEvent('purchase', {
    transaction_id: transactionId, // Le session_id de Stripe
    value: amount,
    currency: 'EUR',
    items: [{
      item_id: planId || 'subscription',
      item_name: planName || 'Abonnement Veridian',
      price: amount,
      quantity: 1,
      item_category: 'subscription'
    }]
  });
}

/**
 * Track Refund (Remboursement)
 *
 * Événement GA4 standard: refund
 *
 * @param transactionId - ID de la transaction originale
 * @param amount - Montant remboursé
 */
export function trackRefund(transactionId: string, amount: number) {
  trackEvent('refund', {
    transaction_id: transactionId,
    value: amount,
    currency: 'EUR'
  });
}

// =============================================================================
// ÉVÉNEMENTS D'ERREUR (Debug et optimisation)
// =============================================================================

/**
 * Track Error (Erreurs techniques ou utilisateur)
 *
 * Événement GA4 standard: exception
 * https://developers.google.com/analytics/devguides/collection/ga4/reference/events#exception
 *
 * @param type - Type d'erreur ('auth_error', 'payment_error', 'api_error', etc.)
 * @param message - Message d'erreur (sans données sensibles!)
 * @param fatal - Si l'erreur bloque l'utilisateur (default: false)
 */
export function trackError(type: string, message: string, fatal: boolean = false) {
  trackEvent('exception', {
    description: `${type}: ${message}`,
    fatal: fatal
  });
}

// =============================================================================
// IDENTIFICATION UTILISATEUR (Cross-device tracking)
// =============================================================================

/**
 * Set User Identity (Associer les sessions à un utilisateur)
 *
 * IMPORTANT: Appeler après signup/login réussi
 * Permet de suivre le même utilisateur sur plusieurs appareils
 *
 * @param userId - ID utilisateur Supabase (UUID)
 */
export function setUserId(userId: string) {
  if (typeof window !== 'undefined' && window.dataLayer) {
    console.log('[GTM] Setting user ID:', userId);
    window.dataLayer.push({
      user_id: userId, // Standard GA4
      event: 'user_id_set'
    });
  }
}

/**
 * Clear User Identity (Déconnexion)
 *
 * À appeler lors du logout
 */
export function clearUserId() {
  if (typeof window !== 'undefined' && window.dataLayer) {
    console.log('[GTM] Clearing user ID');
    window.dataLayer.push({
      user_id: undefined,
      event: 'user_id_cleared'
    });
  }
}

// =============================================================================
// ÉVÉNEMENTS ENGAGEMENT (Comprendre le comportement)
// =============================================================================

/**
 * Track Button Click (Tracking générique de boutons)
 *
 * @param buttonText - Texte du bouton
 * @param buttonLocation - Localisation (ex: 'navbar', 'pricing', 'hero')
 * @param buttonVariant - Variante du bouton (ex: 'primary', 'outline')
 */
export function trackButtonClick(
  buttonText: string,
  buttonLocation?: string,
  buttonVariant?: string
) {
  trackEvent('button_click', {
    button_text: buttonText,
    button_location: buttonLocation || window.location.pathname,
    button_variant: buttonVariant || 'default'
  });
}

/**
 * Track Link Click (Clics sur liens externes)
 *
 * @param linkText - Texte du lien
 * @param linkUrl - URL de destination
 */
export function trackLinkClick(linkText: string, linkUrl: string) {
  const isExternal = linkUrl.startsWith('http') && !linkUrl.includes(window.location.hostname);

  trackEvent('link_click', {
    link_text: linkText,
    link_url: linkUrl,
    link_type: isExternal ? 'external' : 'internal',
    outbound: isExternal
  });
}

/**
 * Track Page View (Navigation SPA)
 *
 * Next.js gère déjà les page views, mais utile pour tracking manuel
 *
 * @param pagePath - Chemin de la page
 * @param pageTitle - Titre de la page
 */
export function trackPageView(pagePath: string, pageTitle?: string) {
  trackEvent('page_view', {
    page_path: pagePath,
    page_title: pageTitle || document.title,
    page_location: window.location.href
  });
}

/**
 * Track Search (Recherche sur le site)
 *
 * Événement GA4 standard: search
 *
 * @param searchTerm - Terme recherché
 */
export function trackSearch(searchTerm: string) {
  trackEvent('search', {
    search_term: searchTerm
  });
}

/**
 * Track View Item (Consultation d'un produit/plan)
 *
 * Événement GA4 standard: view_item
 *
 * @param itemId - ID du plan
 * @param itemName - Nom du plan
 * @param price - Prix
 */
export function trackViewItem(itemId: string, itemName: string, price: number) {
  trackEvent('view_item', {
    currency: 'EUR',
    value: price,
    items: [{
      item_id: itemId,
      item_name: itemName,
      price: price,
      item_category: 'subscription'
    }]
  });
}
