'use client';

import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { Illustration } from './Illustration';
import type { OnboardingUser } from './types';

/**
 * Écran d'accueil — il ne pose aucune question.
 *
 * Son rôle est de poser le contrat : pourquoi on demande quelque chose, et
 * combien de temps ça prend. Sans lui, le client tombe sur un questionnaire
 * sans savoir qui le lui pose ni pourquoi, et le taux d'abandon explose sur
 * la première question.
 */
export function WelcomeScreen({
  user,
  onStart,
  onSkip,
}: {
  user: OnboardingUser;
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5 text-center sm:gap-6">
      <div className="hidden h-[22dvh] w-full max-w-2xl haut:block sm:h-[30dvh]">
        <Illustration cle="accueil" />
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-balance text-2xl font-bold sm:text-3xl">
          Bienvenue {user.prenom}, on prépare votre espace
        </h1>
        {/* « Quatre questions » n'était pas tenable : le parcours en compte
            quatre ou cinq selon les réponses (l'échéance n'apparaît qu'avec un
            chantier). Et le parcours ne portait ni prénom, ni visage, ni
            ville — l'atout numéro un face aux plateformes, c'est justement
            qu'il y a un humain derrière. Autant le dire dès le premier
            écran. */}
        <p className="mx-auto max-w-xl text-balance text-sm text-muted-foreground sm:text-base">
          Quelques questions rapides pour comprendre votre activité. Ensuite on
          active les bons outils sur {user.workspaceName}, et on se cale un
          point ensemble si besoin.
        </p>
        <p className="text-xs text-muted-foreground">Robert, Veridian, Lyon.</p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-2">
        <Button type="button" className="w-full" onClick={onStart}>
          C’est parti
          <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={onSkip}
        >
          Plus tard, aller directement à mon espace
        </Button>
      </div>
    </div>
  );
}
