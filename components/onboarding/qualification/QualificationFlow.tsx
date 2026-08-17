'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { QualificationShell } from './QualificationShell';
import { QuestionScreen } from './QuestionScreen';
import { RecapScreen } from './RecapScreen';
import { WelcomeScreen } from './WelcomeScreen';
import { ecransPertinents, repondre as appliquerReponse } from './questions';
import type {
  EtapeId,
  OnboardingUser,
  Qualification,
  UserOnboardingRecord,
} from './types';

/** État de la sauvegarde des réponses, remonté par la page réelle. */
export type EtatEnregistrement = 'idle' | 'en-cours' | 'erreur';

/**
 * Onboarding qualifiant de première connexion, après le login.
 *
 * Parcours : accueil → les questions pertinentes → récapitulatif. Le nombre
 * d'écrans dépend des réponses (celui qui n'a pas de site ne voit pas la
 * question « refonte ou application ? », il en voit une autre), mais le
 * client ne perçoit aucun branchement : il voit toujours une question à la
 * fois, à la même place.
 *
 * Aucun appel réseau ici. `onTerminer` reçoit l'état complet au format
 * `user_onboarding`, `onRepondre` le reçoit à CHAQUE réponse : le branchement
 * consistera à leur passer des fonctions qui écrivent en base, sans toucher
 * aux écrans.
 *
 * ── Reprise de parcours ──────────────────────────────────────────────────
 * Elle était annoncée partout et implémentée nulle part : l'index démarrait
 * en dur à -1, donc un client qui répondait à deux questions et fermait
 * l'onglet repartait de l'écran d'accueil et devait tout recliquer. C'est le
 * scénario type de la première connexion interrompue, et le premier motif
 * d'abandon définitif. Désormais `index` est calculé au montage : premier
 * écran sans réponse, ou récapitulatif si tout est répondu, et l'accueil
 * n'apparaît que quand rien n'a jamais été répondu.
 *
 * ── Focus ────────────────────────────────────────────────────────────────
 * Changer une `key` React ne déplace JAMAIS le focus, contrairement à ce que
 * prétendait le commentaire précédent : au clavier, après une réponse, le
 * focus tombait sur `document.body` et le Tab suivant repartait du début du
 * document. On donne donc le focus au titre du nouvel écran, comme le fait
 * une vraie navigation SPA, et on annonce le changement dans une zone
 * `aria-live` — sinon le lecteur d'écran reste muet et l'utilisateur croit
 * que son clic n'a rien fait.
 */
export function QualificationFlow({
  user,
  etat,
  onTerminer,
  onRepondre,
  onQuitter,
  enregistrement = 'idle',
}: {
  user: OnboardingUser;
  /** État de départ — permet de reprendre un parcours entamé. */
  etat: UserOnboardingRecord;
  onTerminer?: (etat: UserOnboardingRecord) => void;
  /**
   * Appelé à CHAQUE réponse, avec `metadata.etapeCourante` renseignée.
   *
   * Sans lui, un client qui répond à deux questions sur quatre et ferme
   * l'onglet ne laisse aucune trace en base — alors que le funnel « qui a
   * commencé sans finir » est précisément ce qui motive la table
   * `user_onboarding`.
   */
  onRepondre?: (etat: UserOnboardingRecord) => void;
  /** Sortie anticipée : « plus tard, aller à mon espace ». */
  onQuitter?: () => void;
  /** Permet au récapitulatif de signaler un échec de sauvegarde. */
  enregistrement?: EtatEnregistrement;
}) {
  const [qualification, setQualification] = useState<Qualification>(
    etat.metadata?.qualification ?? {},
  );

  // -1 = écran d'accueil ; 0..n-1 = questions ; n = récapitulatif.
  // Calculé UNE fois, au montage, à partir de l'état reçu.
  const [index, setIndex] = useState(() => indexDeReprise(etat));

  const ecrans = useMemo(() => ecransPertinents(qualification), [qualification]);
  const surAccueil = index < 0;
  const surRecap = index >= ecrans.length;
  const ecran = surAccueil || surRecap ? null : ecrans[index];

  // La barre avance sur l'ensemble accueil + questions + récapitulatif.
  const progression = (index + 1) / (ecrans.length + 1);

  // Focus au changement d'écran — le titre, comme une navigation réelle.
  const titreRef = useRef<HTMLHeadingElement>(null);
  const premierRendu = useRef(true);
  useEffect(() => {
    if (premierRendu.current) {
      premierRendu.current = false;
      // Au montage on ne vole pas le focus : le client vient d'arriver, il
      // n'a encore rien demandé.
      return;
    }
    titreRef.current?.focus();
  }, [index, ecran?.id]);

  const etatComplet = useCallback(
    (q: Qualification, etape: EtapeId, termine: boolean): UserOnboardingRecord => ({
      ...etat,
      completedAt: termine ? new Date().toISOString() : etat.completedAt,
      metadata: {
        ...(etat.metadata ?? {}),
        qualification: q,
        etapeCourante: etape,
      },
    }),
    [etat],
  );

  const repondre = useCallback(
    (value: string) => {
      if (!ecran) return;
      const suivant = appliquerReponse(ecran, qualification, value);
      setQualification(suivant);

      // Répondre fait avancer : un seul geste par question. On recalcule la
      // liste des écrans à partir de la NOUVELLE réponse, car elle peut en
      // ouvrir ou en fermer un (branche « j'ai un site » / « je n'en ai pas »,
      // ou la question d'échéance qui n'apparaît qu'avec un chantier).
      const apres = ecransPertinents(suivant);
      const prochain = index + 1;
      setIndex(prochain);

      const termine = prochain >= apres.length;
      const etape: EtapeId = termine
        ? 'recapitulatif'
        : (apres[prochain]?.id ?? 'recapitulatif');

      // Sauvegarde intermédiaire à chaque réponse : c'est ce qui rend la
      // reprise possible et le funnel d'abandon observable.
      onRepondre?.(etatComplet(suivant, etape, false));
      if (termine) onTerminer?.(etatComplet(suivant, 'recapitulatif', true));
    },
    [ecran, qualification, index, onRepondre, onTerminer, etatComplet],
  );

  const revenir = useCallback(() => setIndex((i) => Math.max(-1, i - 1)), []);

  /** Retour direct sur une question depuis le récapitulatif. */
  const allerA = useCallback(
    (etapeId: EtapeId) => {
      const cible = ecrans.findIndex((e) => e.id === etapeId);
      if (cible >= 0) setIndex(cible);
    },
    [ecrans],
  );

  // Seul l'accueil a un contenu fixe garanti de tenir : on y verrouille le
  // défilement pour supprimer le micro-scroll parasite. Le récapitulatif, lui,
  // a autant de lignes que de recommandations — le verrouiller rendrait son
  // bouton d'action inatteignable sur un petit écran.
  const verrouiller = surAccueil;

  return (
    <QualificationShell
      progression={surAccueil ? undefined : progression}
      verrouillerScroll={verrouiller}
      pied={
        // Le pied disparaissait sur le récapitulatif : le client qui
        // s'apercevait d'un mauvais clic n'avait plus AUCUN moyen de revenir,
        // la seule issue était « Découvrir mon espace ». Il reste maintenant
        // affiché sur les questions ET sur le récapitulatif.
        ecran || surRecap ? (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={revenir}
              className="text-muted-foreground"
            >
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
              Retour
            </Button>
            {/* « Choisissez une réponse pour continuer » a été supprimé :
                l'auto-avance rendait la consigne fausse, et c'était du
                vocabulaire de formulaire administratif. On rassure sur ce qui
                compte vraiment quand on hésite à répondre. */}
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
              Vos réponses sont enregistrées au fur et à mesure.
            </span>
          </>
        ) : undefined
      }
    >
      {/* Annonce du changement d'écran aux lecteurs d'écran. Le titre reçoit
          le focus (donc il est lu), mais sur les navigations où le focus est
          refusé — préférences système, technologie d'assistance — cette zone
          garantit que le changement est verbalisé. */}
      <p aria-live="polite" className="sr-only">
        {ecran ? ecran.titre(user) : surRecap ? 'Votre espace est prêt' : ''}
      </p>

      {surAccueil && (
        <WelcomeScreen
          user={user}
          onStart={() => setIndex(0)}
          onSkip={() => onQuitter?.()}
        />
      )}

      {ecran && (
        // `key` : remonter l'écran à chaque étape rejoue l'animation d'entrée.
        // L'id seul suffit désormais comme clé — les deux branches de la
        // question 2 ont des ids distincts, donc basculer de l'une à l'autre
        // remonte bien le composant (ce que `${id}-${index}` ne faisait pas
        // quand elles partageaient `site-intention`).
        <div
          key={ecran.id}
          className="animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <QuestionScreen
            ecran={ecran}
            user={user}
            valeur={ecran.lire(qualification)}
            onRepondre={repondre}
            titreRef={titreRef}
          />
        </div>
      )}

      {surRecap && (
        <RecapScreen
          user={user}
          qualification={qualification}
          ecrans={ecrans}
          onModifier={allerA}
          onEnter={() => onQuitter?.()}
          enregistrement={enregistrement}
          titreRef={titreRef}
        />
      )}
    </QualificationShell>
  );
}

/**
 * Où reprendre le parcours au montage.
 *
 * Règle : le premier écran pertinent SANS réponse ; le récapitulatif si tout
 * est répondu ; l'accueil seulement si rien ne l'a jamais été. Un client qui
 * revient ne doit jamais avoir à recliquer ce qu'il a déjà dit.
 *
 * Exportée pour être testée seule : c'est une machine à index, et c'est
 * exactement le genre de logique qui se casse en silence.
 */
export function indexDeReprise(etat: UserOnboardingRecord): number {
  const q = etat.metadata?.qualification ?? {};
  const ecrans = ecransPertinents(q);

  const aRepondu = ecrans.some((e) => e.lire(q) !== undefined);
  if (!aRepondu) return -1;

  const premierSansReponse = ecrans.findIndex((e) => e.lire(q) === undefined);
  return premierSansReponse === -1 ? ecrans.length : premierSansReponse;
}
