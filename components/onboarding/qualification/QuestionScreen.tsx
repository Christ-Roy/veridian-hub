'use client';

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import { ChoiceCard } from './ChoiceCard';
import { Illustration } from './Illustration';
import type { EcranQuestionQuelconque, OnboardingUser } from './types';

/**
 * Écran de question générique — un seul composant sert toutes les questions.
 *
 * ── Le point dur : tenir en hauteur, y compris sur un iPhone SE ───────────
 *
 * La promesse est « une question par écran, sans scroll ». Elle tombait
 * précisément sur les écrans à 4 réponses, c'est-à-dire sur les deux écrans
 * qui portent la qualification commerciale : à 375×667 la 4e option était
 * coupée (69 px de débordement), à 375×568 il en manquait deux (182 px) et
 * le pied avec « Retour » disparaissait aussi. Aucun dégradé, aucune ombre
 * ne signalait qu'il fallait défiler : le client croyait que la question
 * n'avait que deux ou trois réponses possibles. Et 667 px n'est pas un cas
 * tordu : c'est un iPhone SE/8, et c'est aussi ce que vaut 100dvh sur un
 * iPhone 13 en Safari, barre d'adresse déployée.
 *
 * Trois parades, dans l'ordre où elles agissent :
 *
 *  1. **Deux colonnes dès 375 px** au-delà de trois options (les libellés
 *     sont courts, ils tiennent en demi-largeur) — c'est ce qui divise par
 *     deux la hauteur des écrans qui débordaient.
 *  2. **L'illustration disparaît sous 640 px de haut** (`haut:`, un
 *     breakpoint de hauteur déclaré dans `tailwind.config.js`). Elle valait
 *     18dvh, soit une centaine de pixels pris à des réponses déjà coupées —
 *     et elle ne transmettait rien à cette taille de toute façon.
 *  3. **Cartes plus compactes sur petit écran** (min-h 3.75rem au lieu de
 *     4.5, gaps réduits), rendues à leur taille normale dès `sm`.
 *
 * Le masque dégradé qui signale un reste à défiler vit dans
 * `QualificationShell`, sur la zone qui défile réellement.
 */
export function QuestionScreen({
  ecran,
  user,
  valeur,
  onRepondre,
  titreRef,
}: {
  ecran: EcranQuestionQuelconque;
  user: OnboardingUser;
  valeur: string | undefined;
  onRepondre: (value: string) => void;
  /** Cible du focus au changement d'écran (cf. `QualificationFlow`). */
  titreRef?: React.Ref<HTMLHeadingElement>;
}) {
  // Au-delà de trois options, deux colonnes DÈS le plus petit écran.
  const deuxColonnes = ecran.options.length > 3;

  const titreId = `question-${ecran.id}`;
  const optionsRef = useRef<HTMLDivElement>(null);

  // Index de l'option qui porte le focus roving : la réponse déjà donnée,
  // sinon la première. C'est le comportement d'un vrai groupe de radios —
  // le groupe entier ne compte que pour UN arrêt de tabulation.
  const indexActif = Math.max(
    0,
    ecran.options.findIndex((o) => o.value === valeur),
  );

  const rovingRef = useRef(indexActif);
  useEffect(() => {
    rovingRef.current = indexActif;
  }, [indexActif, ecran.id]);

  /**
   * Flèches = déplacement dans le groupe, comme un `<input type="radio">`.
   * Haut/gauche ET bas/droite : la grille passe d'une à deux colonnes selon
   * la largeur, les deux axes doivent marcher.
   */
  const naviguer =
    (index: number): React.KeyboardEventHandler<HTMLButtonElement> =>
    (event) => {
      const dernier = ecran.options.length - 1;
      let cible: number | null = null;

      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        cible = index === dernier ? 0 : index + 1;
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        cible = index === 0 ? dernier : index - 1;
      } else if (event.key === 'Home') {
        cible = 0;
      } else if (event.key === 'End') {
        cible = dernier;
      }

      if (cible === null) return;
      event.preventDefault();

      const boutons =
        optionsRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      boutons?.[cible]?.focus();
      rovingRef.current = cible;

      // Le motif radio ARIA sélectionne avec les flèches, comme des radios
      // natives. Ici, cette sélection fait aussi avancer le questionnaire.
      boutons?.[cible]?.click();
    };

  return (
    <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-center lg:gap-10">
      {/* Masquée sous 640 px de HAUTEUR : sur un écran court, ces ~100 px
          sont exactement ce qui coupait la dernière réponse. */}
      <div className="hidden h-[18dvh] w-full shrink-0 haut:block sm:h-[24dvh] lg:h-[46dvh] lg:w-[44%]">
        <Illustration cle={ecran.illustration} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:gap-4">
        <div className="flex flex-col gap-1 text-center sm:gap-1.5 lg:text-left">
          <h1
            id={titreId}
            ref={titreRef}
            tabIndex={-1}
            className="text-balance text-xl font-bold outline-none sm:text-2xl lg:text-3xl"
          >
            {ecran.titre(user)}
          </h1>
          {ecran.sousTitre && (
            <p className="text-balance text-sm text-muted-foreground">
              {ecran.sousTitre}
            </p>
          )}
        </div>

        <div
          ref={optionsRef}
          role="radiogroup"
          aria-labelledby={titreId}
          className={cn(
            'grid gap-2 sm:gap-2.5',
            deuxColonnes ? 'grid-cols-2' : 'grid-cols-1',
          )}
        >
          {ecran.options.map((option, index) => (
            <ChoiceCard
              key={option.value}
              label={option.label}
              description={option.description}
              selectionnee={valeur === option.value}
              tabulable={index === indexActif}
              onKeyDown={naviguer(index)}
              onSelect={() => onRepondre(option.value)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
