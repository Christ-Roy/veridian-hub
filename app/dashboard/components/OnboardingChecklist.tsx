'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, Sparkles } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { celebrate } from '@/lib/confetti';

/** Clé localStorage : mémorise quels items d'onboarding étaient déjà cochés
 *  au précédent rendu, pour ne déclencher les confettis qu'aux NOUVELLES
 *  complétions (transition false → true). */
const SEEN_KEY = 'veridian:onboarding:seen';

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
  id: string;
  label: string;
  done: boolean;
  hint: string;
}

export function OnboardingChecklist({
  workspaceName,
  hasStartedApp,
  hasInvitedMember,
}: OnboardingChecklistProps) {
  const items: ChecklistItem[] = [
    {
      id: 'app',
      label: 'Activez votre premier outil',
      done: hasStartedApp,
      hint: 'Choisissez un outil ci-dessous pour commencer.',
    },
    {
      id: 'member',
      label: 'Invitez un membre dans votre espace',
      done: hasInvitedMember,
      hint: 'Optionnel — travaillez à plusieurs sur le même espace.',
    },
    {
      id: 'rename',
      label: 'Personnalisez le nom de votre espace',
      done: false,
      hint: 'Optionnel — un nom parlant pour votre équipe.',
    },
  ];

  // Confettis à CHAQUE item qui vient d'être coché (transition false → true).
  // On compare l'ensemble des items "done" avec celui mémorisé au dernier
  // rendu (localStorage) pour ne célébrer que les nouvelles complétions.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const doneNow = items.filter((i) => i.done).map((i) => i.id);
    let seen: string[] = [];
    try {
      seen = JSON.parse(window.localStorage.getItem(SEEN_KEY) || '[]');
    } catch {
      seen = [];
    }
    const freshlyDone = doneNow.filter((id) => !seen.includes(id));
    if (freshlyDone.length > 0) {
      celebrate();
    }
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(doneNow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStartedApp, hasInvitedMember]);

  // Onboarding considéré abouti dès la première app démarrée : le user a
  // franchi l'étape clé du funnel, on libère l'écran.
  if (hasStartedApp) return null;

  return (
    <Card className="relief-card mb-8 border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Sparkles className="h-5 w-5 text-primary" />
          Bienvenue sur {workspaceName}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Quelques étapes pour bien démarrer.
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
          Vous pouvez renommer votre espace depuis les{' '}
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
