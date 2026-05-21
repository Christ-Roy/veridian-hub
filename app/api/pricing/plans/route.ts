// app/api/pricing/plans/route.ts
//
// Expose le catalogue canonique @veridian/shared en JSON pour les consommateurs
// non-TypeScript (Notifuse Go, futurs services Python/Rust, scripts d'audit
// pricing, etc.).
//
// Stratégie cache :
//  - `dynamic = 'force-static'` : le payload est byte-identique pour tous
//  - `revalidate = 3600` : ISR 1h (regénéré si rebuild ou TTL expiré)
//
// Consommation Notifuse : appel HTTP au boot avec TTL local 1h, fallback
// sur valeurs par défaut si Hub down (générosité = pas de risque sécu).

import {
  PLANS,
  LEAD_REFILL_PRICING_CENTS,
  MAX_LEADS_PER_REFILL_ORDER,
  ANNUAL_PERKS,
} from '@veridian/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const revalidate = 3600;

// Version locale au repo Hub — bump quand le submodule pointe sur un nouveau
// SHA shared/ et qu'on a vérifié que l'API reste rétro-compatible.
const PRICING_API_VERSION = '0.1.0';

export async function GET() {
  return Response.json(
    {
      plans: PLANS,
      refill: {
        pricing_cents: LEAD_REFILL_PRICING_CENTS,
        max_per_order: MAX_LEADS_PER_REFILL_ORDER,
      },
      annual_perks: ANNUAL_PERKS,
      version: PRICING_API_VERSION,
      generated_at: new Date().toISOString(),
    },
    {
      headers: {
        // Cache CDN 1h (Cloudflare/Vercel respectent), revalidate stale-while-revalidate
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      },
    },
  );
}
