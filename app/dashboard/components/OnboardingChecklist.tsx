import Link from 'next/link';
import { CheckCircle2, Circle, Sparkles } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Repère d'accueil "premier pas" du dashboard, affiché tant que l'onboarding
 * n'est pas terminé. Onboarding inline (pas de modale bloquante) — cf ticket
 * `todo/2026-05-22-ui-onboarding-premier-dashboard.md`.
 *
 * État de complétion par heuristique (pas de colonne `onboardingCompleted`,
 * donc pas de migration DB) :
 *  - `hasStartedApp` : le user a démarré Prospection OU Notifuse.
 *  - `hasInvitedMember` : le workspace compte plus d'un membre.
 *
 * Tant que `hasStartedApp` est faux, le repère reste visible — il ne
 * disparaît PAS au premier trial sur une app, contrairement à l'ancien
 * `<Alert>` gardé sur `!tenant`. Une fois la première app démarrée,
 * l'onboarding est considéré abouti et le composant ne rend rien.
 */

export interface OnboardingChecklistProps {
  /** Nom réel du workspace (depuis le layout). */
  workspaceName: string;
  /** Une app au moins a été démarrée (Prospection ou Notifuse). */
  hasStartedApp: boolean;
  /** Le workspace compte au moins un second membre. */
  hasInvitedMember: boolean;
}

interface ChecklistItem {
  label: string;
  done: boolean;
  hint: string;
}

export function OnboardingChecklist({
  workspaceName,
  hasStartedApp,
  hasInvitedMember,
}: OnboardingChecklistProps) {
  // Onboarding considéré abouti dès la première app démarrée : le user a
  // franchi l'étape clé du funnel, on libère l'écran.
  if (hasStartedApp) return null;

  const items: ChecklistItem[] = [
    {
      label: 'Démarre ta première app',
      done: hasStartedApp,
      hint: 'Choisis Prospection ou Notifuse ci-dessous — essai gratuit, sans carte bancaire.',
    },
    {
      label: 'Invite un membre dans ton workspace',
      done: hasInvitedMember,
      hint: 'Optionnel — travaille à plusieurs sur le même espace.',
    },
    {
      label: 'Personnalise le nom de ton workspace',
      done: false,
      hint: 'Optionnel — un nom parlant pour ton équipe.',
    },
  ];

  return (
    <Card className="mb-8 border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Sparkles className="h-5 w-5 text-primary" />
          Bienvenue sur {workspaceName}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Quelques étapes pour démarrer. Pas de carte bancaire, 15 jours
          offerts par app.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.label} className="flex items-start gap-3">
              {item.done ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              )}
              <div>
                <div
                  className={
                    item.done
                      ? 'text-sm font-medium text-muted-foreground line-through'
                      : 'text-sm font-medium'
                  }
                >
                  {item.label}
                </div>
                <div className="text-xs text-muted-foreground">{item.hint}</div>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Tu peux renommer ton workspace depuis les{' '}
          <Link
            href="/dashboard/settings"
            className="text-primary hover:underline"
          >
            paramètres
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
