import { Clock, LifeBuoy, RefreshCw, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Écrans 5 et 6 — les sorties de route.
 *
 * `expire` : le lien a dépassé sa durée de validité. En production, on évite
 * tout CTA mort : soit un handler de renvoi réel est fourni, soit on renvoie
 * vers la connexion et le support.
 *
 * `technique` : le provisioning a échoué. On ne montre jamais de trace
 * technique au client, on lui donne un recours.
 */
export function ErrorScreen({
  variant,
  email,
  supportHref = 'mailto:contact@veridian.site',
  onRetry,
}: {
  variant: 'expire' | 'technique';
  /** Email du destinataire, affiché quand on peut renvoyer un lien. */
  email?: string;
  supportHref?: string;
  onRetry?: () => void;
}) {
  const expire = variant === 'expire';
  const Icon = expire ? Clock : AlertTriangle;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <span
          className={
            expire
              ? 'flex h-12 w-12 items-center justify-center rounded-full bg-warning/15'
              : 'flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15'
          }
        >
          <Icon
            className={expire ? 'h-6 w-6 text-warning' : 'h-6 w-6 text-destructive'}
            aria-hidden
          />
        </span>
        <h1 className="text-2xl font-bold">
          {expire ? 'Ce lien a expiré' : 'Une erreur est survenue'}
        </h1>
        <p className="text-balance text-sm text-muted-foreground">
          {expire
            ? 'Pour votre sécurité, les liens d’activation ont une durée de vie limitée. Si vous avez déjà choisi un mot de passe, connectez-vous. Sinon, contactez Veridian pour recevoir un nouveau lien.'
            : 'Nous n’avons pas pu terminer l’activation de votre compte. Rien n’est perdu, vous pouvez réessayer.'}
        </p>
      </div>

      {expire && email && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-center">
          <div className="text-xs text-muted-foreground">Compte concerné</div>
          <div className="truncate text-sm font-medium">{email}</div>
        </div>
      )}

      {onRetry ? (
        <Button type="button" className="w-full" onClick={onRetry}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
          {expire ? 'Demander un nouveau lien' : 'Réessayer'}
        </Button>
      ) : (
        <Button asChild className="w-full">
          <a href="/login">Aller à la connexion</a>
        </Button>
      )}

      <a
        href={supportHref}
        className="flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <LifeBuoy className="h-3.5 w-3.5" aria-hidden />
        Contacter le support
      </a>
    </div>
  );
}
