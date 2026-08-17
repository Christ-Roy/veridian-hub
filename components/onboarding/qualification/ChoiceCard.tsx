'use client';

import { forwardRef } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Carte de réponse tactile — la seule zone cliquable d'un écran de question.
 *
 * Grande cible (le doigt, pas la souris), un clic suffit : sélectionner
 * répond ET fait avancer. Pas de « choisissez puis validez », qui double le
 * nombre de gestes sur un parcours déjà court.
 *
 * ── Accessibilité : un vrai groupe de boutons radio ──────────────────────
 * C'était un `<button aria-pressed>` isolé. Un lecteur d'écran annonçait
 * « bouton, enfoncé » sur des choix pourtant mutuellement exclusifs : rien ne
 * disait qu'ils formaient un ensemble, rien ne disait « 2 sur 4 », et la
 * question n'était reliée à rien. Au clavier, il fallait tabuler option par
 * option. C'est désormais le motif `radiogroup` (cf. `QuestionScreen`) :
 * `role="radio"` + `aria-checked`, navigation aux flèches, et focus roving
 * (`tabIndex` sur la seule option active) — le groupe entier compte pour un
 * arrêt de tabulation, comme un vrai groupe de radios natif.
 *
 * ── Couleur de la sélection ──────────────────────────────────────────────
 * La carte choisie NE PEUT PAS s'appuyer sur `--primary` : dans ce thème,
 * `--primary` est un noir neutre et `--accent` un gris neutre. La carte
 * sélectionnée devenait grise cerclée de noir au milieu d'un fond ambre/rose
 * — elle se lisait comme désactivée, et les cartes non choisies (crème
 * chaud) étaient plus désirables que celle qu'on venait de choisir. On
 * utilise la couleur de marque (`--choice-selected`, le même ambre que le
 * bouton principal), définie dans `styles/main.css` pour les deux thèmes.
 */
export const ChoiceCard = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    description: string;
    selectionnee: boolean;
    onSelect: () => void;
    /** Focus roving : une seule option du groupe est tabulable. */
    tabulable?: boolean;
    onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  }
>(function ChoiceCard(
  { label, description, selectionnee, onSelect, tabulable = true, onKeyDown },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selectionnee}
      tabIndex={tabulable ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex min-h-[3.75rem] w-full flex-col justify-center gap-0.5 rounded-xl border p-3 text-left transition-all',
        'sm:min-h-[4.5rem] sm:gap-1 sm:p-4',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selectionnee
          ? 'choice-selected'
          : 'border-border bg-card hover:border-primary/40 hover:bg-accent/50',
      )}
    >
      <span className="pr-8 text-sm font-semibold text-card-foreground sm:text-base">
        {label}
      </span>
      <span className="pr-8 text-xs text-muted-foreground sm:text-sm">
        {description}
      </span>

      {selectionnee && (
        <span
          aria-hidden
          className="choice-selected-pastille absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full"
        >
          <Check className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
});
