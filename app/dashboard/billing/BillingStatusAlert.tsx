import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StripePortalButton } from './StripePortalButton';
import { resolvePlateformeUrl } from '@/lib/marketing-url';
import { getStatusAlert } from './status-presentation';

interface BillingStatusAlertProps {
  /** Statut Stripe de la subscription courante. */
  status: string;
}

/**
 * Alerte de tête de page billing.
 *
 * Affiche un bandeau actionnable quand l'état de la subscription demande une
 * intervention de l'utilisateur :
 *   - `past_due` / `unpaid` → bandeau d'urgence + CTA Stripe Portal (carte).
 *   - `canceled` / `incomplete_expired` → bandeau + CTA "Réactiver".
 *
 * Rend `null` pour les états sains (`active`, `trialing`, …) — pas de bandeau
 * parasite. Le contenu (ton, libellés) vient de `status-presentation.ts`.
 */
export function BillingStatusAlert({ status }: BillingStatusAlertProps) {
  const alert = getStatusAlert(status);
  if (!alert) {
    return null;
  }

  const isUrgent = alert.cta === 'portal';
  const Icon = isUrgent ? AlertTriangle : RefreshCw;

  return (
    <Alert variant={alert.variant}>
      <Icon className="h-4 w-4" />
      <AlertTitle>{alert.title}</AlertTitle>
      <AlertDescription>
        <p>{alert.description}</p>
        <div className="mt-3">
          {alert.cta === 'portal' ? (
            <StripePortalButton
              label={alert.ctaLabel}
              variant="default"
              className="w-fit"
            />
          ) : (
            <Button asChild className="w-fit">
              <a href={resolvePlateformeUrl()} target="_blank" rel="noopener noreferrer">
                {alert.ctaLabel}
              </a>
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
