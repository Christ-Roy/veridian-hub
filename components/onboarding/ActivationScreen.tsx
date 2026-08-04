import { ArrowRight, Mail, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VeridianWordmark } from '@/components/icons/VeridianHubLogo';

import type { OnboardingInvite } from './types';

/**
 * Écran 1 — le client vient de cliquer sur le lien reçu par email. On lui
 * confirme qui l'invite, sur quel espace, et avec quels outils, avant de
 * lui demander quoi que ce soit. Aucune saisie ici : un seul bouton.
 */
export function ActivationScreen({
  invite,
  onContinue,
}: {
  invite: OnboardingInvite;
  onContinue?: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-bold">Bienvenue, votre espace vous attend</h1>
        <p className="text-balance text-sm text-muted-foreground">
          {invite.invitedBy} vous a ouvert un accès à{' '}
          <span className="font-medium text-foreground">
            {invite.workspaceName}
          </span>
          .
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Votre identifiant</div>
          <div className="truncate text-sm font-medium">{invite.email}</div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">Vos outils sont déjà installés</div>
        <ul className="flex flex-col gap-3">
          {invite.apps.map((app) => (
            <li key={app.id} className="flex items-start gap-3">
              <VeridianWordmark size="xs" suffix={app.suffix} className="mt-0.5 shrink-0" />
              <span className="text-sm text-muted-foreground">{app.tagline}</span>
            </li>
          ))}
        </ul>
      </div>

      <Button type="button" className="w-full" onClick={onContinue}>
        Activer mon compte
        <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
      </Button>

      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        Lien personnel, valable jusqu’au {formatEcheance(invite.expiresAt)}.
      </p>
    </div>
  );
}

/** Date d'expiration en français, sans heure (l'heure n'aide pas le client). */
export function formatEcheance(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris',
  }).format(new Date(iso));
}
