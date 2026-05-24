import { LEAD_REFILL_PRICING_CENTS } from '@veridian/shared';
import type { ProspectionLocalPlan } from '@/lib/billing/refill-leads';

/**
 * Tableau lecture seule des paliers tarifaires pour le plan courant.
 * Affichage : "1 — 99 leads → 0,50€/lead", etc.
 *
 * Lit la grille canonique `shared/pricing/refill.ts` (même source que le serveur).
 */
export function PricingGridInfo({ plan }: { plan: ProspectionLocalPlan }) {
  const tiers = LEAD_REFILL_PRICING_CENTS[plan];

  return (
    <ul className="divide-y text-sm">
      {tiers.map((tier, i) => (
        <li key={i} className="flex items-center justify-between py-3">
          <span className="text-muted-foreground tabular-nums">
            {formatRange(tier.min, tier.max)} leads
          </span>
          <span className="font-medium tabular-nums">
            {formatPerLead(tier.perLead)}/lead
          </span>
        </li>
      ))}
    </ul>
  );
}

function formatRange(min: number, max: number): string {
  if (!Number.isFinite(max)) {
    return `${min.toLocaleString('fr-FR')}+`;
  }
  return `${min.toLocaleString('fr-FR')} — ${max.toLocaleString('fr-FR')}`;
}

function formatPerLead(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
