'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { VeridianHubLogo } from '@/components/icons/VeridianHubLogo';
import { cn } from '@/lib/utils';

/**
 * Habillage plein écran du parcours de qualification.
 *
 * Le point dur est le mobile. Trois pièges, trois parades :
 *
 *  1. `100vh` ment sur mobile — il compte la barre d'adresse qui se rétracte,
 *     donc l'écran déborde et la page devient scrollable « sur du vide ». On
 *     dimensionne en `100dvh` (avec repli `100vh` pour les vieux navigateurs,
 *     écrasé par la règle suivante quand `dvh` est supporté).
 *  2. Le scroll doit vivre DANS la zone centrale, jamais sur la page — sinon
 *     l'en-tête et le pied disparaissent au défilement et le bouton d'action
 *     se retrouve hors de portée. Le conteneur est donc `overflow-hidden`, et
 *     seule la zone centrale défile (`min-h-0` obligatoire : sans lui, un
 *     enfant flex refuse de rétrécir et déborde).
 *  3. Encoche et barre gestuelle mangent les bords — on réserve les
 *     `safe-area-inset` en haut et en bas.
 *
 * Ce découpage en-tête / zone défilante / pied est repris de l'onboarding ASD
 * (`~/site-clients/www.animal-services-distribution.com`), qui a essuyé les
 * plâtres de ces trois pièges en production.
 */
export function QualificationShell({
  children,
  pied,
  /** Progression de 0 à 1, affichée en filet sous l'en-tête. */
  progression,
  /**
   * `true` sur les écrans courts garantis de tenir : on verrouille alors tout
   * défilement, ce qui supprime le micro-scroll parasite d'un ou deux pixels
   * dû aux arrondis de `dvh`.
   */
  verrouillerScroll = false,
}: {
  children: ReactNode;
  pied?: ReactNode;
  progression?: number;
  verrouillerScroll?: boolean;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const [resteADefiler, setResteADefiler] = useState(false);

  /** Y a-t-il du contenu sous le bas visible de la zone ? */
  const mesurer = useCallback(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    // 4 px de tolérance : les arrondis de `dvh` produisent régulièrement un
    // ou deux pixels de débordement qui ne cachent rien.
    const reste = zone.scrollHeight - zone.clientHeight - zone.scrollTop > 4;
    setResteADefiler(reste);
  }, []);

  // Re-mesure au montage, à chaque changement d'écran, et au redimensionnement
  // (rotation du téléphone, barre d'adresse qui se rétracte).
  useEffect(() => {
    mesurer();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(mesurer);
    const zone = zoneRef.current;
    if (zone) {
      observer.observe(zone);
      if (zone.firstElementChild) observer.observe(zone.firstElementChild);
    }
    return () => observer.disconnect();
  }, [mesurer, children]);

  return (
    <div
      className={cn(
        // `h-screen` = repli 100vh ; la variante `supports-` prend le relais
        // dès que `dvh` est disponible (tous les navigateurs depuis 2023).
        // Deux classes `h-*` brutes ne suffiraient pas : c'est l'ordre dans la
        // feuille générée qui trancherait, pas celui écrit ici.
        // `auth-screen` : le gradient fort de la DA Veridian, celui des pages
        // de connexion. La première connexion est un moment de bascule, elle
        // mérite le même traitement que le login — pas le fond plat de l'app.
        'auth-screen flex h-screen flex-col overflow-hidden supports-[height:100dvh]:h-[100dvh]',
        'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
        'pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
      )}
    >
      {/* ── En-tête : toujours visible, ne défile jamais ─────────────────── */}
      <header className="shrink-0 border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <VeridianHubLogo size="sm" />
          {/* « Configuration de votre espace » était du vocabulaire de
              panneau de réglages logiciel. L'atout numéro un de Robert face
              aux plateformes, c'est qu'il y a un humain derrière : autant
              que le premier contact le dise. */}
          <p className="ml-auto text-xs text-muted-foreground sm:text-sm">
            On prépare votre espace
          </p>
        </div>

        {/* Progression : un filet, pas un compteur. Voir un « 2 / 6 » donne
            surtout envie d'abandonner ; une barre qui avance rassure sans
            chiffrer l'effort restant. */}
        {typeof progression === 'number' && (
          <div
            className="h-0.5 w-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progression * 100)}
            aria-label="Progression de la configuration"
          >
            <div
              className="h-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${Math.min(100, Math.max(0, progression * 100))}%` }}
            />
          </div>
        )}
      </header>

      {/* ── Zone centrale : la SEULE qui défile ──────────────────────────── */}
      {/*
        Masque dégradé en bas — UNIQUEMENT quand il reste vraiment quelque
        chose à défiler. Le débordement doit rester l'exception (cf.
        `QuestionScreen`), mais il reste possible : police système agrandie,
        libellé long, écran de 568 px de haut. Sans indice visuel, le client
        croit que la question n'a que les réponses qu'il voit — c'est
        exactement comme ça qu'on perdait la 4e option sans que personne ne
        s'en aperçoive. On mesure plutôt que d'appliquer le masque en
        permanence : un dégradé qui mange le bas d'un contenu qui tient
        déjà serait une régression pour tous les autres écrans.
      */}
      <div
        ref={zoneRef}
        onScroll={mesurer}
        className={cn(
          'flex min-h-0 flex-1 flex-col overscroll-contain px-4 py-4',
          verrouillerScroll ? 'overflow-hidden' : 'overflow-y-auto',
          resteADefiler &&
            '[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent_100%)]',
        )}
      >
        {/* `my-auto` centre un contenu court sans rogner le haut d'un contenu
            long (ce que ferait `justify-center`). */}
        <div className="mx-auto my-auto w-full max-w-6xl">{children}</div>
      </div>

      {/* ── Pied : navigation, toujours atteignable ──────────────────────── */}
      {pied && (
        <footer className="shrink-0 border-t border-border bg-card/60 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
            {pied}
          </div>
        </footer>
      )}
    </div>
  );
}
