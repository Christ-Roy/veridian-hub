import { CalendarClock, CheckCircle2, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CardContent } from '@/components/ui/card';
import { getStatusBadge } from './status-presentation';

/**
 * Vue sérialisée d'une subscription pour l'affichage. La page billing résout
 * les `BigInt` (montant) et les `Date` en types primitifs avant de passer ici
 * — ce composant ne dépend ni de Prisma ni de Stripe.
 */
export interface SubscriptionView {
  status: string;
  /** Nom du plan (ex. "Pro"). */
  planName: string;
  /** Montant en centimes. */
  unitAmount: number;
  /** Devise ISO (ex. "EUR"). */
  currency: string;
  /** Intervalle de facturation (ex. "month"). */
  interval: string | null;
  /** Date de fin de période courante, format ISO ou `null`. */
  currentPeriodEnd: string | null;
  /** Date de fin d'essai, format ISO ou `null`. */
  trialEnd: string | null;
  /** Date d'annulation programmée (fin de période), format ISO ou `null`. */
  cancelAt: string | null;
}

/** Libellé FR de l'intervalle de facturation Stripe. */
function intervalLabel(interval: string | null): string {
  switch (interval) {
    case 'month':
      return 'mois';
    case 'year':
      return 'an';
    case 'week':
      return 'semaine';
    case 'day':
      return 'jour';
    default:
      return interval ?? 'période';
  }
}

/** Formate une date ISO en `fr-FR`, ou `null` si la date est absente/invalide. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

interface SubscriptionCardProps {
  subscription: SubscriptionView;
}

/**
 * Carte "plan actuel" mise en avant : nom du plan, prix, badge de statut et
 * les dates pertinentes selon l'état (fin d'essai, prochaine échéance,
 * annulation programmée). Ton sobre, pas de compteur anxiogène.
 */
export function SubscriptionCard({ subscription }: SubscriptionCardProps) {
  const badge = getStatusBadge(subscription.status);
  const isTrialing = subscription.status === 'trialing';
  const trialEnd = formatDate(subscription.trialEnd);
  const periodEnd = formatDate(subscription.currentPeriodEnd);
  const cancelAt = formatDate(subscription.cancelAt);

  const priceLabel = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: (subscription.currency || 'EUR').toUpperCase(),
    minimumFractionDigits: 0,
  }).format(subscription.unitAmount / 100);

  return (
    <CardContent className="space-y-5">
      {/* Nom du plan + statut */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xl font-semibold">{subscription.planName}</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {/* Prix */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl font-bold">{priceLabel}</span>
        <span className="text-muted-foreground">
          / {intervalLabel(subscription.interval)}
        </span>
      </div>

      {/* Essai en cours — ton positif, sans deadline en gros */}
      {isTrialing && trialEnd && (
        <div className="flex items-center gap-2 rounded-md bg-info/10 px-3 py-2 text-sm">
          <Clock className="h-4 w-4 text-info" aria-hidden="true" />
          <span>
            Essai gratuit en cours — accès complet jusqu’au{' '}
            <span className="font-medium">{trialEnd}</span>.
          </span>
        </div>
      )}

      {/* Dates clés */}
      <dl className="space-y-2 border-t pt-4 text-sm">
        {!isTrialing && periodEnd && !cancelAt && (
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Prochaine échéance
            </dt>
            <dd className="font-medium">{periodEnd}</dd>
          </div>
        )}

        {cancelAt && (
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              Accès maintenu jusqu’au
            </dt>
            <dd className="font-medium">{cancelAt}</dd>
          </div>
        )}
      </dl>
    </CardContent>
  );
}
