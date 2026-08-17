'use client';

import { useEffect } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Loader2,
  Pencil,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VeridianWordmark } from '@/components/icons/VeridianHubLogo';
import { celebrate } from '@/lib/confetti';

import { Illustration } from './Illustration';
import { recommandations } from './recommandation';
import type {
  EcranQuestionQuelconque,
  EtapeId,
  OnboardingUser,
  Qualification,
} from './types';

/** Le créneau de 15 minutes de Robert (même lien que le tunnel d'audit). */
const LIEN_RDV = 'https://cal.com/robert.brunon/15min';
/** Sortie de secours quand il n'y a pas de chantier à cadrer. */
const MAIL_ROBERT = 'mailto:robert@veridian.site';

/**
 * Écran de conclusion — il rend au client ce qu'il vient de donner.
 *
 * Trois choses s'y jouent, dans cet ordre d'importance commerciale :
 *
 *  1. **La conversion.** Le client vient éventuellement de déclarer une
 *     refonte plus une prospection, soit le panier le plus cher du
 *     catalogue. L'écran lui répondait une liste de cartes grises et un
 *     bouton « Découvrir mon espace » : aucun moyen de parler à quelqu'un,
 *     aucun créneau, aucune promesse de rappel. Un chantier ne s'active pas
 *     en cliquant, il se vend au téléphone — et le seul moment où le client
 *     est chaud, c'est ici, juste après avoir dit ce qu'il voulait. Dès
 *     qu'un chantier est déclaré, on affiche donc un bloc humain avec un
 *     créneau, et « Découvrir mon espace » passe en action secondaire.
 *  2. **La restitution.** L'écran n'affichait que les recommandations, pas
 *     les réponses. Chaque réponse est maintenant rappelée et cliquable pour
 *     revenir la corriger (le pied porte aussi un « Retour »).
 *  3. **La hiérarchie.** Les apps portaient un beau wordmark, les chantiers
 *     une pastille grise « Projet » : la ligne à plusieurs milliers d'euros
 *     avait l'air moins importante que l'app gratuite. Le chantier passe en
 *     couleur de marque, avec un libellé honnête (« On en parle ensemble »)
 *     — personne ne met en place une refonte en cliquant sur un bouton.
 */
export function RecapScreen({
  user,
  qualification,
  ecrans,
  onModifier,
  onEnter,
  enregistrement = 'idle',
  titreRef,
}: {
  user: OnboardingUser;
  qualification: Qualification;
  /** Les écrans parcourus, pour rappeler les réponses données. */
  ecrans?: EcranQuestionQuelconque[];
  /** Revenir corriger une réponse. */
  onModifier?: (etape: EtapeId) => void;
  onEnter: () => void;
  enregistrement?: 'idle' | 'en-cours' | 'erreur';
  titreRef?: React.Ref<HTMLHeadingElement>;
}) {
  const items = recommandations(qualification);
  const chantiers = items.filter((i) => i.nature === 'chantier');
  const apps = items.filter((i) => i.nature === 'app');
  const aChantier = chantiers.length > 0;

  // Les réponses réellement données, dans l'ordre du parcours.
  const reponses = (ecrans ?? []).flatMap((ecran) => {
    const valeur = ecran.lire(qualification);
    if (valeur === undefined) return [];
    const option = ecran.options.find((o) => o.value === valeur);
    if (!option) return [];
    return [{ id: ecran.id, question: ecran.titre(user), reponse: option.label }];
  });

  useEffect(() => {
    celebrate();
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 text-center sm:gap-6">
      <div className="hidden h-[16dvh] w-full max-w-xl haut:block sm:h-[24dvh]">
        <Illustration cle="recapitulatif" />
      </div>

      <div className="flex flex-col gap-2">
        <h1
          ref={titreRef}
          tabIndex={-1}
          className="flex items-center justify-center gap-2 text-balance text-2xl font-bold outline-none sm:text-3xl"
        >
          <Sparkles className="h-6 w-6 text-primary" aria-hidden />
          Votre espace est prêt
        </h1>
        {/* « Voici ce qu'on met en place » était faux pour un chantier :
            personne ne met en place une refonte en cliquant. Le client
            repartait soit en croyant que c'était lancé, soit en sentant le
            décalage. On distingue donc les deux natures. */}
        <p className="mx-auto max-w-xl text-balance text-sm text-muted-foreground sm:text-base">
          {aChantier && apps.length > 0
            ? `Voici ce qu’on active tout de suite, ${user.prenom}, et ce qu’on cadre ensemble.`
            : aChantier
              ? `Voici ce qu’on cadre ensemble, ${user.prenom}.`
              : `Voici ce qu’on active pour vous, ${user.prenom}.`}
        </p>
      </div>

      {enregistrement === 'erreur' && (
        <p
          role="alert"
          className="flex w-full max-w-xl items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-left text-sm text-foreground"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
            aria-hidden
          />
          <span>
            Vos réponses n’ont pas pu être enregistrées. Rien n’est perdu :
            dites-le à Robert, il les reprendra avec vous.
          </span>
        </p>
      )}

      {enregistrement === 'en-cours' && (
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Enregistrement de vos réponses…
        </p>
      )}

      <ul className="flex w-full max-w-xl flex-col gap-2 text-left">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-start gap-3 rounded-xl border border-border bg-card p-3"
          >
            <span className="mt-0.5 shrink-0">
              {item.suffixe ? (
                <VeridianWordmark size="xs" suffix={item.suffixe} />
              ) : (
                <span className="choice-selected-pastille whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold">
                  On en parle ensemble
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-card-foreground">
                {item.titre}
              </span>
              <span className="block text-xs text-muted-foreground">
                {item.raison}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* ── La conversion ─────────────────────────────────────────────────
          Un chantier déclaré = un rendez-vous proposé, tout de suite. C'est
          le trou le plus cher de tout l'onboarding quand il manque : la
          qualification a fait son travail, la conversion était à zéro. */}
      {aChantier ? (
        <div className="flex w-full max-w-xl flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="choice-selected-pastille flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            >
              <CalendarClock className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground">
                Robert, votre interlocuteur chez Veridian, Lyon
              </p>
              <p className="text-xs text-muted-foreground">
                {chantiers[0].titre}, on la cadre en 15 minutes au téléphone.
                Choisissez un créneau, je vous rappelle.
              </p>
            </div>
          </div>
          <Button asChild className="w-full">
            <a href={LIEN_RDV} target="_blank" rel="noreferrer noopener">
              Réserver 15 minutes avec Robert
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Une question ?{' '}
          <a href={MAIL_ROBERT} className="underline underline-offset-4">
            Écrivez à Robert
          </a>
          .
        </p>
      )}

      {/* ── Ce que le client a répondu ────────────────────────────────────
          Restitution + correction. Selon le chemin, quatre questions peuvent
          ne produire qu'UNE seule recommandation : sans ce rappel, l'écran
          final paraissait dérisoire au regard de l'effort demandé. */}
      {reponses.length > 0 && (
        <div className="flex w-full max-w-xl flex-col gap-1 text-left">
          <p className="text-xs font-medium text-muted-foreground">
            Ce que vous nous avez dit
          </p>
          <ul className="flex flex-col">
            {reponses.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onModifier?.(r.id)}
                  disabled={!onModifier}
                  className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                >
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {r.question}{' '}
                    <span className="font-semibold text-card-foreground">
                      {r.reponse}
                    </span>
                  </span>
                  {onModifier && (
                    <>
                      <Pencil
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                        aria-hidden
                      />
                      <span className="sr-only">Modifier cette réponse</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Secondaire quand il y a un chantier : le rendez-vous passe devant. */}
      <Button
        type="button"
        variant={aChantier ? 'outline' : 'default'}
        className="w-full max-w-sm"
        onClick={onEnter}
        disabled={enregistrement === 'en-cours'}
        aria-busy={enregistrement === 'en-cours'}
      >
        {enregistrement === 'en-cours' ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Enregistrement…
          </>
        ) : (
          <>
            Découvrir mon espace
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
          </>
        )}
      </Button>
    </div>
  );
}
