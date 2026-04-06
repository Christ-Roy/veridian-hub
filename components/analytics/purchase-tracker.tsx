'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';
import { trackPurchase } from '@/lib/gtm';

/**
 * PurchaseTracker - Track automatiquement les purchases après un checkout Stripe
 *
 * Ce composant :
 * 1. Détecte si l'utilisateur a une subscription récente (créée dans les 2 dernières minutes)
 * 2. Track l'événement purchase vers GA4
 * 3. Ne track qu'une seule fois par session pour éviter les doublons
 *
 * Fonctionne avec le webhook Stripe existant qui stocke déjà les subscriptions en DB
 *
 * À placer dans le dashboard layout
 */
export function PurchaseTracker() {
  const hasTracked = useRef(false);

  useEffect(() => {
    // Ne track qu'une seule fois par session
    if (hasTracked.current) return;

    const trackRecentPurchase = async () => {
      try {
        const supabase = createClient();

        // Récupérer l'utilisateur et sa subscription active la plus récente
        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
          console.log('[PurchaseTracker] No user found');
          return;
        }

        // Récupérer la subscription la plus récente de l'utilisateur
        const { data: subscriptions, error: subError } = await supabase
          .from('subscriptions')
          .select(`
            *,
            prices!inner (
              id,
              unit_amount,
              currency,
              product_id,
              products!inner (
                id,
                name
              )
            )
          `)
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1);

        if (subError) {
          console.error('[PurchaseTracker] Error fetching subscription:', subError);
          return;
        }

        if (!subscriptions || subscriptions.length === 0) {
          console.log('[PurchaseTracker] No subscription found');
          return;
        }

        // Cast explicite car TypeScript n'arrive pas à inférer le type avec les jointures
        const subscription = subscriptions[0] as any;
        const subscriptionCreatedAt = subscription.created_at
          ? new Date(subscription.created_at)
          : new Date();
        const now = new Date();
        const diffMinutes = (now.getTime() - subscriptionCreatedAt.getTime()) / 1000 / 60;

        // Si la subscription a été créée il y a moins de 2 minutes, c'est un nouveau purchase
        const isRecentPurchase = diffMinutes < 2;

        if (!isRecentPurchase) {
          console.log('[PurchaseTracker] No recent purchase detected');
          return;
        }

        console.log('[PurchaseTracker] Recent purchase detected!', {
          subscriptionId: subscription.stripe_subscription_id,
          createdAt: subscription.created,
          minutesAgo: diffMinutes.toFixed(2)
        });

        // Extraire les données du purchase
        const price = subscription.prices as any;
        const amount = price?.unit_amount ? price.unit_amount / 100 : 0;
        const productName = price?.products?.name || 'Abonnement Veridian';
        const priceId = subscription.stripe_price_id;

        // Track l'événement purchase
        trackPurchase(
          subscription.stripe_subscription_id,
          amount,
          priceId,
          productName
        );

        console.log('[PurchaseTracker] Purchase event tracked:', {
          transactionId: subscription.stripe_subscription_id,
          amount,
          product: productName
        });

        hasTracked.current = true;

      } catch (error: any) {
        console.error('[PurchaseTracker] Error:', error);
      }
    };

    // Petit délai pour s'assurer que la session Supabase est établie
    const timer = setTimeout(trackRecentPurchase, 1000);

    return () => clearTimeout(timer);
  }, []);

  // Ce composant ne rend rien
  return null;
}
