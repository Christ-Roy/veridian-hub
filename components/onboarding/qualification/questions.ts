/**
 * Le parcours de qualification, décrit en données.
 *
 * Pourquoi des données plutôt qu'un composant par écran : les questions ont
 * exactement la même forme (une question, quelques options exclusives, une
 * illustration). Les décrire ici rend une reformulation, un réordonnancement
 * ou une question supplémentaire gratuits — et garantit que tous les écrans
 * se comportent pareil (auto-avance, retour, reprise).
 *
 * 🔴 Les écrans sont typés SUR LA CLÉ qu'ils écrivent (`definirEcran`). Ce
 * n'est pas de la décoration : sans ça, `options: OptionQuestion[]` dégénère
 * en `value: string`, une faute de frappe (`'oiu'`) compile, et le `as` de
 * `ecrire` écrase l'erreur. Le seul endroit qui manipule encore une chaîne
 * large est `repondre()`, tout en bas, avec UN rétrécissement commenté.
 *
 * L'ordre suit une logique commerciale, pas l'ordre littéral de la demande :
 * on part du plus concret et du plus universel (le site web, que tout le
 * monde comprend) pour finir par le plus engageant (la recherche de clients
 * professionnels), et par l'échéance, qui n'apparaît que si le client a
 * déclaré un chantier. Le client s'échauffe sur des questions faciles avant
 * qu'on lui demande ses intentions commerciales.
 *
 * ── Règle de rédaction, non négociable ───────────────────────────────────
 * Zéro sigle, zéro jargon d'agence. Le client type est un boulanger, un
 * coiffeur, un artisan, un restaurateur. « B2B », « back-office », « base
 * qualifiée » ne veulent rien dire pour lui — et c'est précisément le profil
 * censé cocher ces options-là. Une option qu'il ne comprend pas est une
 * option qu'il ne coche pas : il coche « Pas pour l'instant » par défaut et
 * on perd l'information.
 *
 * Deuxième règle : aucune option ne doit FABRIQUER un refus. « J'ai déjà ce
 * qu'il me faut » met dans la bouche d'un dirigeant de PME « j'ai assez de
 * clients », ce qu'aucun ne pense — mais l'écrire ainsi rend le clic
 * confortable et referme le sujet pour de bon. On formule les « non » comme
 * des « plus tard », qui restent exploitables.
 */

import type {
  CleQualification,
  EcranQuestion,
  EcranQuestionQuelconque,
  Qualification,
} from './types';
import { aUnChantierDatable } from './recommandation';

/**
 * Déclare un écran en gardant le lien entre sa clé, ses options et son
 * `ecrire`. C'est cette fonction qui fait échouer la compilation sur une
 * valeur d'option inexistante.
 */
function definirEcran<K extends CleQualification>(
  ecran: EcranQuestion<K>,
): EcranQuestion<K> {
  return ecran;
}

export const ECRANS_QUESTIONS: EcranQuestionQuelconque[] = [
  // ── 1. Le point de départ : a-t-il un site ? ──────────────────────────────
  definirEcran({
    id: 'site-actuel',
    cle: 'siteActuel',
    titre: () => 'Avez-vous déjà un site web ?',
    sousTitre: 'On part de là où vous en êtes, pas de zéro.',
    illustration: 'site-actuel',
    options: [
      {
        value: 'oui',
        label: 'Oui, j’ai un site',
        description: 'En ligne aujourd’hui, quel que soit son état.',
      },
      {
        value: 'non',
        label: 'Non, pas encore',
        description: 'Rien en ligne, ou seulement une page de réseau social.',
      },
    ],
    lire: (q) => q.siteActuel,
    ecrire: (q, v) => ({
      ...q,
      siteActuel: v,
      // Changer de réponse invalide la suite : les deux branches ne posent
      // pas la même question. Sans ça, on garderait une réponse orpheline.
      intentionSiteExistant: undefined,
      intentionSansSite: undefined,
    }),
  }),

  // ── 2a. Il a un site → que veut-il en faire ? ─────────────────────────────
  definirEcran({
    id: 'site-intention-existant',
    cle: 'intentionSiteExistant',
    titre: () => 'Qu’aimeriez-vous en faire ?',
    sousTitre: 'Il n’y a pas de mauvaise réponse, même « rien pour l’instant ».',
    illustration: 'site-intention',
    options: [
      {
        value: 'satisfait',
        label: 'Il me convient',
        description: 'Je n’ai pas de chantier prévu dessus.',
      },
      {
        value: 'refonte',
        label: 'Le refaire',
        description: 'Le fond est bon, la forme a vieilli.',
      },
      {
        value: 'application',
        label: 'Aller plus loin',
        description:
          'Des espaces clients, de la gestion en ligne, un vrai outil et plus seulement une vitrine.',
      },
    ],
    lire: (q) => q.intentionSiteExistant,
    ecrire: (q, v) => ({ ...q, intentionSiteExistant: v }),
    pertinent: (q) => q.siteActuel === 'oui',
  }),

  // ── 2b. Il n'a pas de site → de quoi a-t-il besoin ? ──────────────────────
  // Même position dans le parcours que 2a : le client ne voit jamais les
  // deux, il ne perçoit donc pas de branchement. En revanche l'id est
  // DISTINCT (cf. `EtapeId`) : c'est ce qui permet à React de remonter
  // l'écran quand on bascule d'une branche à l'autre, et à la reprise de
  // parcours de désigner le bon.
  definirEcran({
    id: 'site-intention-creation',
    cle: 'intentionSansSite',
    titre: () => 'Qu’est-ce qui vous servirait le plus ?',
    sousTitre: 'Une idée approximative suffit, on affinera ensemble.',
    illustration: 'site-creation',
    options: [
      {
        value: 'vitrine',
        label: 'Un site vitrine',
        description: 'Être trouvable, présenter ce que vous faites.',
      },
      {
        value: 'boutique',
        label: 'Une boutique en ligne',
        description: 'Vendre vos produits directement.',
      },
      {
        value: 'application',
        label: 'Un outil sur mesure',
        description: 'Pour gérer votre activité, ou pour vos clients directement.',
      },
      {
        value: 'indecis',
        label: 'Je ne sais pas encore',
        description: 'On en parlera, c’est notre métier.',
      },
    ],
    lire: (q) => q.intentionSansSite,
    ecrire: (q, v) => ({ ...q, intentionSansSite: v }),
    pertinent: (q) => q.siteActuel === 'non',
  }),

  // ── 3. Rester en contact avec ses clients ────────────────────────────────
  // Ancienne formulation : « Envoyer des emails à vos clients » + « newsletters,
  // relances, confirmations de commande ». Vocabulaire d'e-commerce : l'artisan
  // qui relance ses devis ne s'y reconnaissait pas, le commerçant de quartier
  // ne voyait pas pourquoi il ferait une newsletter. On récoltait un « non » de
  // formulation, pas un « non » de besoin — et cette question tombe AVANT
  // qu'on sache s'il vend aux entreprises ou aux particuliers, donc on ne
  // peut pas adapter le vocabulaire après coup. La reformulation couvre les
  // deux marchés sans déplacer aucun écran.
  definirEcran({
    id: 'emailing',
    cle: 'emailing',
    titre: () => 'Vous gardez le contact avec vos clients ?',
    sousTitre:
      'Un email au bon moment : une relance, une offre, une nouvelle. C’est ce que fait Veridian Mail.',
    illustration: 'emailing',
    options: [
      {
        value: 'liste-existante',
        label: 'Oui, j’ai déjà des contacts',
        description: 'Une liste existe, elle dort quelque part.',
      },
      {
        value: 'depuis-zero',
        label: 'Oui, mais je pars de zéro',
        description: 'Aucune liste pour l’instant, l’envie est là.',
      },
      {
        value: 'plus-tard',
        label: 'Plus tard',
        description: 'On verra ça une fois le reste en place.',
      },
    ],
    lire: (q) => q.emailing,
    ecrire: (q, v) => ({ ...q, emailing: v }),
  }),

  // ── 4. Aller chercher des clients professionnels ─────────────────────────
  definirEcran({
    id: 'prospection',
    cle: 'prospection',
    titre: () => 'Cherchez-vous de nouveaux clients professionnels ?',
    sousTitre:
      'Les coordonnées à jour des entreprises françaises, filtrables par métier et par département.',
    illustration: 'prospection',
    options: [
      {
        value: 'priorite',
        label: 'Oui, c’est ma priorité',
        description: 'Trouver des clients passe avant le reste.',
      },
      {
        value: 'explorer',
        label: 'Oui, à explorer',
        description: 'Curieux de voir ce que ça donne.',
      },
      {
        value: 'b2c',
        label: 'Je vends aux particuliers',
        description: 'Mes clients sont des particuliers, pas des entreprises.',
      },
      {
        value: 'plus-tard',
        label: 'Pas maintenant',
        description: 'Je préfère consolider avant d’aller démarcher.',
      },
    ],
    lire: (q) => q.prospection,
    ecrire: (q, v) => ({ ...q, prospection: v }),
  }),

  // ── 5. L'échéance ────────────────────────────────────────────────────────
  // La seule information qui change l'ordre des appels de Robert le
  // lendemain matin. Deux clients qui ont coché « Le refaire » sont sinon
  // indiscernables : l'un veut ouvrir avant Noël, l'autre regarde pour l'an
  // prochain. Affichée UNIQUEMENT si un chantier a été déclenché — donc
  // invisible pour ceux qui n'achètent rien, donc sans coût d'abandon sur
  // cette population.
  //
  // Volontairement PAS demandé : le budget (fait fuir et fait mentir, il se
  // pose au téléphone), le secteur et la taille (déjà lisibles dans le nom
  // du workspace et le domaine de l'email), et « qui décide » (le dirigeant
  // de PME qui remplit le formulaire EST le décideur).
  definirEcran({
    id: 'echeance',
    cle: 'echeance',
    titre: () => 'C’est pour quand ?',
    sousTitre: 'Une idée approximative suffit, ça nous aide à nous organiser.',
    illustration: 'echeance',
    options: [
      {
        value: 'urgent',
        label: 'Le plus tôt possible',
        description: 'J’aimerais que ça avance maintenant.',
      },
      {
        value: 'trimestre',
        label: 'Dans les trois mois',
        description: 'C’est prévu, sans urgence.',
      },
      {
        value: 'sans-date',
        label: 'Pas de date',
        description: 'Je regarde ce que ça donne.',
      },
    ],
    lire: (q) => q.echeance,
    ecrire: (q, v) => ({ ...q, echeance: v }),
    pertinent: aUnChantierDatable,
  }),
];

/** Les écrans réellement à afficher, au vu des réponses déjà données. */
export function ecransPertinents(q: Qualification): EcranQuestionQuelconque[] {
  return ECRANS_QUESTIONS.filter((e) => !e.pertinent || e.pertinent(q));
}

/**
 * Applique la réponse d'un clic à l'état de qualification.
 *
 * C'est LE seul point du parcours qui élargit une valeur en `string` : la
 * valeur vient d'un événement DOM, elle n'a donc pas de type plus précis à
 * ce moment-là. On le fait ici, une fois, plutôt que dans chaque `ecrire`
 * — où le cast masquait, en prime, les vraies erreurs de saisie.
 */
export function repondre(
  ecran: EcranQuestionQuelconque,
  q: Qualification,
  value: string,
): Qualification {
  const ecrire = ecran.ecrire as (etat: Qualification, v: string) => Qualification;
  return ecrire(q, value);
}
