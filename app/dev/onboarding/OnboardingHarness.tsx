'use client';

import { useCallback, useEffect, useState } from 'react';
import { Monitor, RotateCcw, Smartphone, SunMoon } from 'lucide-react';
import { useTheme } from 'next-themes';

import { OnboardingScreen } from '@/components/onboarding';
import type { OnboardingStateId, OnboardingStep } from '@/components/onboarding';
import {
  MOCK_INVITE,
  MOCK_STEPS_ECHEC,
  MOCK_STEPS_EN_COURS,
  MOCK_STEPS_TERMINE,
} from '@/components/onboarding/mocks';
import { cn } from '@/lib/utils';

/** Les états proposés dans la barre de l'atelier, dans l'ordre du flow. */
const ETATS: { id: OnboardingStateId; label: string }[] = [
  { id: 'activation', label: 'Compte à activer' },
  { id: 'mot-de-passe', label: 'Mot de passe à définir' },
  { id: 'en-cours', label: 'Onboarding en cours' },
  { id: 'termine', label: 'Onboarding terminé' },
  { id: 'erreur', label: 'Erreur' },
  { id: 'token-expire', label: 'Lien expiré' },
];

/** Variantes de provisioning disponibles pour l'écran « en cours ». */
const VARIANTES_ETAPES: { id: string; label: string; steps: OnboardingStep[] }[] = [
  { id: 'partiel', label: 'À mi-parcours', steps: MOCK_STEPS_EN_COURS },
  { id: 'complet', label: 'Tout au vert', steps: MOCK_STEPS_TERMINE },
  { id: 'echec', label: 'Échec provisioning', steps: MOCK_STEPS_ECHEC },
];

/** Largeurs de prévisualisation (le cadre, pas la fenêtre du navigateur). */
const LARGEURS: { id: string; label: string; icon: typeof Monitor; width: string }[] = [
  { id: 'desktop', label: 'Bureau', icon: Monitor, width: '100%' },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, width: '375px' },
];

/**
 * Barre de contrôle de l'atelier + rendu de l'écran sélectionné.
 *
 * L'état courant est reflété dans l'URL (`?etat=...`) via `history.replaceState`
 * — on garde ainsi un lien partageable vers un écran précis sans provoquer de
 * navigation Next (qui remonterait tout l'arbre et couperait les animations).
 */
export function OnboardingHarness({
  etatInitial,
}: {
  etatInitial: OnboardingStateId;
}) {
  const [etat, setEtat] = useState<OnboardingStateId>(etatInitial);
  const [variante, setVariante] = useState(VARIANTES_ETAPES[0].id);
  const [largeur, setLargeur] = useState(LARGEURS[0].id);
  // Force le remontage de l'écran : sert à rejouer confettis et animations.
  const [rejeu, setRejeu] = useState(0);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('etat', etat);
    window.history.replaceState(null, '', url.toString());
  }, [etat]);

  const changerEtat = useCallback((next: OnboardingStateId) => {
    setEtat(next);
    setRejeu((n) => n + 1);
  }, []);

  const steps =
    VARIANTES_ETAPES.find((v) => v.id === variante)?.steps ?? MOCK_STEPS_EN_COURS;
  const largeurCourante =
    LARGEURS.find((l) => l.id === largeur)?.width ?? '100%';

  return (
    <div className="min-h-screen bg-background">
      {/* ------------------------------- Barre de contrôle ------------------ */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
              Atelier UI
            </span>
            <span className="text-sm font-medium">Onboarding première connexion</span>
            <span className="text-xs text-muted-foreground">
              Données fictives, aucune session ni base de données.
            </span>

            <div className="ml-auto flex items-center gap-2">
              {LARGEURS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setLargeur(id)}
                  aria-pressed={largeur === id}
                  title={label}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors',
                    largeur === id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="sr-only">{label}</span>
                </button>
              ))}

              <button
                type="button"
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                title="Basculer clair / sombre"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
              >
                <SunMoon className="h-4 w-4" aria-hidden />
                <span className="sr-only">Basculer le thème</span>
              </button>

              <button
                type="button"
                onClick={() => setRejeu((n) => n + 1)}
                title="Rejouer l’écran (animations, confettis)"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                <span className="sr-only">Rejouer l’écran</span>
              </button>
            </div>
          </div>

          <nav className="flex flex-wrap gap-2" aria-label="États du flow">
            {ETATS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => changerEtat(id)}
                aria-pressed={etat === id}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  etat === id
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          {etat === 'en-cours' && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Provisioning :</span>
              {VARIANTES_ETAPES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setVariante(id)}
                  aria-pressed={variante === id}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    variante === id
                      ? 'border-transparent bg-secondary text-secondary-foreground'
                      : 'border-border bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* ------------------------------- Prévisualisation ------------------- */}
      <main className="flex justify-center p-4">
        <div
          className="w-full overflow-hidden rounded-lg border border-border"
          style={{ maxWidth: largeurCourante }}
        >
          <OnboardingScreen
            key={`${etat}-${variante}-${rejeu}`}
            state={etat}
            invite={MOCK_INVITE}
            steps={steps}
            onActiver={() => changerEtat('mot-de-passe')}
            onDefinirMotDePasse={() => changerEtat('en-cours')}
            onRenvoyerLien={() => changerEtat('activation')}
            onReessayer={() => changerEtat('en-cours')}
            onEntrer={() => changerEtat('termine')}
          />
        </div>
      </main>
    </div>
  );
}
