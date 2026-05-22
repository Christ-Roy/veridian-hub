'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Check, X, Loader2 } from 'lucide-react';
import type { Plan, PlanKey, Interval } from '@/lib/pricing/plans';

interface PricingGridProps {
  bundles: Plan[];
  notifuse: Plan[];
  prospection: Plan[];
  /** Plan déjà actif côté user (pour montrer "Plan actuel" au lieu de "Choisir"). */
  currentPlanKey?: PlanKey | null;
  /** Plan à pré-sélectionner depuis searchParams (`?plan=veridian-pro`). */
  preselectedPlan?: string;
  /** Interval à pré-sélectionner (`?interval=year`). */
  preselectedInterval?: Interval;
  /** Si user pas loggé, on l'envoie sur signup avant checkout. */
  isAuthenticated: boolean;
  /** Redirect après checkout réussi. */
  successRedirect?: string;
}

export function PricingGrid({
  bundles,
  notifuse,
  prospection,
  currentPlanKey = null,
  preselectedInterval = 'month',
  isAuthenticated,
  successRedirect,
}: PricingGridProps) {
  const [interval, setInterval] = useState<Interval>(preselectedInterval);
  const [loading, setLoading] = useState<PlanKey | null>(null);

  async function handleSelectPlan(key: PlanKey) {
    // Plans gratuits → pas de checkout, redirige vers /dashboard pour activer
    const plan = [...bundles, ...notifuse, ...prospection].find((p) => p.key === key);
    if (!plan) return;

    if (plan.price_eur === 0) {
      // Free plan → go to dashboard, the user clicks "Commencer essai" there
      window.location.href = isAuthenticated ? '/dashboard' : `/signup?next=${encodeURIComponent('/dashboard')}`;
      return;
    }

    if (!isAuthenticated) {
      // Pas loggé → signup d'abord, on garde le plan en queryparam
      const next = `/pricing?plan=${key}&interval=${interval}`;
      window.location.href = `/signup?next=${encodeURIComponent(next)}`;
      return;
    }

    setLoading(key);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: key, interval, redirect: successRedirect }),
      });
      const data = await res.json();

      if (!res.ok || !data.url) {
        toast.error('Erreur de checkout', {
          description: data.error || 'Réessaye dans quelques secondes',
          duration: 5000,
        });
        return;
      }

      window.location.href = data.url;
    } catch (e: any) {
      toast.error('Erreur réseau', {
        description: e?.message || 'Réessaye dans quelques secondes',
        duration: 5000,
      });
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="container mx-auto px-4 py-12 max-w-7xl">
      {/* Hero */}
      <div className="text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
          Tarifs Veridian
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Choisis un bundle tout-en-un ou paie à la carte par app. Essai gratuit
          15 jours sur chaque plan, sans carte bancaire.
        </p>

        {/* Switch mensuel / annuel */}
        <div className="inline-flex items-center gap-1 mt-6 p-1 rounded-full bg-muted">
          <button
            onClick={() => setInterval('month')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              interval === 'month' ? 'bg-card shadow text-foreground' : 'text-muted-foreground'
            }`}
          >
            Mensuel
          </button>
          <button
            onClick={() => setInterval('year')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              interval === 'year' ? 'bg-card shadow text-foreground' : 'text-muted-foreground'
            }`}
          >
            Annuel <span className="text-xs text-success ml-1">-15%</span>
          </button>
        </div>
      </div>

      {/* Section Bundles (hero) */}
      {bundles.length > 0 && (
        <section className="mb-16">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold tracking-tight">
              Bundles Veridian
            </h2>
            <p className="text-sm text-muted-foreground">
              Toutes les apps incluses avec un prix dégressif.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {bundles.map((plan) => (
              <PlanCard
                key={plan.key}
                plan={plan}
                interval={interval}
                isCurrentPlan={currentPlanKey === plan.key}
                loading={loading === plan.key}
                onSelect={() => handleSelectPlan(plan.key)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Section à la carte */}
      <section>
        <div className="mb-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            Ou paie à la carte
          </h2>
          <p className="text-sm text-muted-foreground">
            Active uniquement les apps dont tu as besoin.
          </p>
        </div>

        {notifuse.length > 0 && (
          <div className="mb-10">
            <h3 className="text-lg font-medium mb-3 text-muted-foreground">
              📧 Notifuse — Emails transactionnels
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {notifuse.map((plan) => (
                <PlanCard
                  key={plan.key}
                  plan={plan}
                  interval={interval}
                  isCurrentPlan={currentPlanKey === plan.key}
                  loading={loading === plan.key}
                  onSelect={() => handleSelectPlan(plan.key)}
                  compact
                />
              ))}
            </div>
          </div>
        )}

        {prospection.length > 0 && (
          <div>
            <h3 className="text-lg font-medium mb-3 text-muted-foreground">
              🎯 Prospection — Qualification de leads .fr
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {prospection.map((plan) => (
                <PlanCard
                  key={plan.key}
                  plan={plan}
                  interval={interval}
                  isCurrentPlan={currentPlanKey === plan.key}
                  loading={loading === plan.key}
                  onSelect={() => handleSelectPlan(plan.key)}
                  compact
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <p className="text-center text-xs text-muted-foreground mt-12">
        Paiement sécurisé par Stripe. Annulation à tout moment depuis ton dashboard.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanCard (présentation)
// ─────────────────────────────────────────────────────────────────────────────

interface PlanCardProps {
  plan: Plan;
  interval: Interval;
  isCurrentPlan: boolean;
  loading: boolean;
  onSelect: () => void;
  compact?: boolean;
}

function PlanCard({ plan, interval, isCurrentPlan, loading, onSelect, compact = false }: PlanCardProps) {
  const isFree = plan.price_eur === 0;
  const priceMonth = plan.price_eur;
  const priceYear = plan.price_eur_yearly_per_month;
  const displayedPrice = interval === 'year' && priceYear != null ? priceYear : priceMonth;
  const hasYearlyOption = priceYear != null;

  const ctaLabel = isCurrentPlan
    ? 'Plan actuel'
    : isFree
      ? 'Démarrer gratuitement'
      : `Choisir ${plan.name.replace(/^(Notifuse|Prospection|Veridian) /, '')}`;

  return (
    <Card
      className={`p-6 flex flex-col h-full transition-shadow hover:shadow-lg ${
        plan.recommended ? 'ring-2 ring-primary relative' : ''
      }`}
    >
      {plan.recommended && (
        <Badge className="absolute -top-2 left-1/2 -translate-x-1/2 text-xs">
          Recommandé
        </Badge>
      )}

      <div className="mb-4">
        <h3 className={`font-semibold ${compact ? 'text-base' : 'text-xl'}`}>{plan.name}</h3>
        <p className="text-xs text-muted-foreground mt-1">{plan.tagline}</p>
      </div>

      <div className="mb-4">
        <div className="flex items-baseline gap-1">
          <span className={`font-bold ${compact ? 'text-2xl' : 'text-3xl'}`}>
            {isFree ? '0€' : `${displayedPrice}€`}
          </span>
          {!isFree && (
            <span className="text-sm text-muted-foreground">
              /mois{interval === 'year' && hasYearlyOption ? ' (facturé annuellement)' : ''}
            </span>
          )}
        </div>
      </div>

      <ul className="space-y-2 mb-6 flex-1">
        {plan.features.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {f.included ? (
              <Check className="h-4 w-4 text-success shrink-0 mt-0.5" />
            ) : (
              <X className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" />
            )}
            <span className={f.included ? '' : 'text-muted-foreground line-through'}>
              {f.label}
            </span>
          </li>
        ))}
      </ul>

      <Button
        onClick={onSelect}
        disabled={loading || isCurrentPlan}
        variant={plan.recommended ? 'default' : 'outline'}
        className="w-full"
        size={compact ? 'default' : 'lg'}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Redirection...
          </>
        ) : (
          ctaLabel
        )}
      </Button>
    </Card>
  );
}
