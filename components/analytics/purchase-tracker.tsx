'use client';

import { useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { trackPurchase } from '@/lib/gtm';

/**
 * PurchaseTracker — Auth.js v5
 *
 * Track le purchase event juste après un checkout Stripe.
 * Récupère la subscription la plus récente via /api/account/recent-subscription.
 * Si elle a moins de 2 minutes -> fire l'event GA4.
 */
export function PurchaseTracker() {
  const { status } = useSession();
  const hasTracked = useRef(false);

  useEffect(() => {
    if (hasTracked.current) return;
    if (status !== 'authenticated') return;

    const trackRecentPurchase = async () => {
      try {
        const res = await fetch('/api/account/recent-subscription', {
          credentials: 'same-origin',
        });
        if (!res.ok) {
          if (res.status !== 401) {
            console.warn('[PurchaseTracker] API error:', res.status);
          }
          return;
        }

        const { subscription } = await res.json();
        if (!subscription) return;

        const subscriptionCreatedAt = subscription.created_at
          ? new Date(subscription.created_at)
          : new Date();
        const now = new Date();
        const diffMinutes = (now.getTime() - subscriptionCreatedAt.getTime()) / 1000 / 60;

        const isRecentPurchase = diffMinutes < 2;
        if (!isRecentPurchase) return;

        const price = subscription.prices;
        const amount = price?.unit_amount ? price.unit_amount / 100 : 0;
        const productName = price?.products?.name || 'Abonnement Veridian';
        const priceId = subscription.stripe_price_id;

        trackPurchase(
          subscription.stripe_subscription_id,
          amount,
          priceId,
          productName,
        );

        hasTracked.current = true;
      } catch (error: any) {
        console.error('[PurchaseTracker] Error:', error);
      }
    };

    const timer = setTimeout(trackRecentPurchase, 1000);
    return () => clearTimeout(timer);
  }, [status]);

  return null;
}
