'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  calculateRefillCostCents,
  MAX_LEADS_PER_REFILL_ORDER,
} from '@veridian/shared';
import type { ProspectionLocalPlan } from '@/lib/billing/refill-leads';

/**
 * Form Client Component d'achat refill leads.
 *
 * - Slider 1..MAX_LEADS_PER_REFILL_ORDER lié à un input number (sync bidirectionnel).
 * - Calcul live via la même grille que le serveur (`shared/pricing/refill.ts`).
 * - Submit POST `/api/billing/refill-leads/checkout` puis redirect Stripe.
 *
 * Pattern bouton aligné sur StripePortalButton : `disabled` + label dynamique
 * ("Acheter …"/"Chargement…") pour éviter le double-submit.
 */
export function RefillLeadsForm({
  tenantId,
  prospectionPlan,
}: {
  tenantId: string;
  prospectionPlan: ProspectionLocalPlan;
}) {
  const [quantity, setQuantity] = useState<number>(100);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Calcul live, mémoïsé pour éviter de recomputer à chaque render parent.
  // Source de vérité serveur reste la route POST (grille identique).
  const { totalCents, perLeadCents, error } = useMemo(() => {
    try {
      const total = calculateRefillCostCents(prospectionPlan, quantity);
      return {
        totalCents: total,
        perLeadCents: quantity > 0 ? total / quantity : 0,
        error: null as string | null,
      };
    } catch (err) {
      return {
        totalCents: 0,
        perLeadCents: 0,
        error: err instanceof Error ? err.message : 'Quantité invalide',
      };
    }
  }, [prospectionPlan, quantity]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (error || quantity < 1 || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/billing/refill-leads/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, quantity }),
      });
      const data = await res.json();

      if (!res.ok || !data.url) {
        const message = mapErrorCode(data.error) ?? 'Impossible de lancer le paiement.';
        toast.error('Erreur', { description: message, duration: 6000 });
        setIsSubmitting(false);
        return;
      }

      // Redirect Stripe Checkout
      window.location.href = data.url;
    } catch (err) {
      toast.error('Erreur réseau', {
        description: err instanceof Error ? err.message : 'Réessaie.',
        duration: 5000,
      });
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="refill-quantity">Quantité</Label>
        <div className="flex items-center gap-4">
          <input
            id="refill-quantity-slider"
            type="range"
            min={1}
            max={MAX_LEADS_PER_REFILL_ORDER}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 1)}
            disabled={isSubmitting}
            aria-label="Quantité de leads à acheter (slider)"
            className="flex-1 h-2 rounded-full bg-muted accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Input
            id="refill-quantity"
            type="number"
            min={1}
            max={MAX_LEADS_PER_REFILL_ORDER}
            value={quantity}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) {
                setQuantity(Math.min(Math.max(v, 1), MAX_LEADS_PER_REFILL_ORDER));
              }
            }}
            disabled={isSubmitting}
            className="w-32"
          />
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 p-6 text-center space-y-2">
        <p className="text-sm text-muted-foreground">Tu achètes</p>
        <p className="text-4xl font-bold tabular-nums">
          {quantity.toLocaleString('fr-FR')} <span className="text-2xl font-semibold text-muted-foreground">leads</span>
        </p>
        <p className="text-3xl font-semibold text-primary tabular-nums pt-2">
          {formatEuro(totalCents)} <span className="text-base font-normal text-muted-foreground">TTC*</span>
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">
          Soit {formatEuro(perLeadCents, true)}/lead
        </p>
        {error && (
          <p className="text-sm text-destructive pt-2" role="alert">
            {error}
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        *TVA calculée à l&apos;étape paiement Stripe selon ton pays.
      </p>

      <Button
        type="submit"
        size="lg"
        disabled={isSubmitting || !!error || quantity < 1}
        className="w-full"
      >
        {isSubmitting
          ? 'Redirection vers le paiement…'
          : `Acheter ${quantity.toLocaleString('fr-FR')} leads — ${formatEuro(totalCents)}`}
      </Button>
    </form>
  );
}

function formatEuro(cents: number, withDecimalsAlways = false): string {
  const euros = cents / 100;
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: withDecimalsAlways ? 2 : euros >= 1 ? 2 : 2,
  }).format(euros);
}

function mapErrorCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  switch (code) {
    case 'rate_limited':
      return 'Trop de tentatives, réessaie dans une minute.';
    case 'tenant_not_found_or_forbidden':
      return "Ce workspace Prospection est introuvable sur ton compte.";
    case 'invalid_quantity':
      return 'Quantité invalide pour ton plan.';
    case 'invalid_payload':
      return 'Données envoyées invalides.';
    case 'stripe_product_not_configured':
      return 'Service de paiement non configuré. Contacte le support.';
    case 'stripe_customer_failed':
    case 'stripe_session_failed':
    case 'stripe_session_no_url':
      return 'Stripe est temporairement indisponible. Réessaie dans quelques minutes.';
    case 'database_error':
      return 'Erreur base de données. Réessaie.';
    default:
      return null;
  }
}
