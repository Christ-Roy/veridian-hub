/**
 * Traduction des réponses en recommandations d'apps et de chantiers.
 *
 * C'est la contrepartie du questionnaire : le client a répondu, il doit voir
 * ce que ça change pour lui. Sans ce retour, la qualification ressemble à un
 * formulaire administratif ; avec, elle ressemble à une configuration.
 *
 * La logique vit ici, pas dans le composant, pour rester testable et pour que
 * le futur branchement serveur puisse la réutiliser telle quelle (c'est elle
 * qui décidera quelles apps provisionner).
 *
 * ── Règle commerciale ────────────────────────────────────────────────────
 * 🔴 AUCUNE branche ne doit finir sans au moins une raison de reparler à
 * Robert. On n'écrit jamais au client qu'il n'y a rien à faire avec nous :
 * formaliser à sa place la conclusion « je n'ai pas besoin de Veridian » est
 * le pire message possible sur l'écran final d'un onboarding. Un prospect
 * qui a un site dont il ne mesure rien et qui vend aux particuliers n'est pas
 * un prospect perdu — c'est un prospect à qui on n'a pas encore parlé.
 */

import type { IntentionSansSite, Qualification } from './types';

export interface Recommandation {
  /** Identifiant de l'app ou du chantier. */
  id: string;
  /** Libellé affiché (suffixe de marque pour les apps Veridian). */
  suffixe?: string;
  titre: string;
  /** Pourquoi on le propose, formulé à partir de SA réponse. */
  raison: string;
  /** Activable tout de suite, ou sujet à discuter avec Robert. */
  nature: 'app' | 'chantier';
}

/**
 * Libellés du chantier de création, par intention.
 *
 * Typé `Record<IntentionSansSite, …>` et non `Record<string, …>` : ajouter
 * une valeur à l'union doit casser la compilation ici. Avec `string`, une
 * nouvelle intention passait sans erreur et le récapitulatif affichait
 * silencieusement le libellé de repli.
 */
const LIBELLES_CREATION: Record<IntentionSansSite, string> = {
  vitrine: 'Création de votre site vitrine',
  boutique: 'Création de votre boutique en ligne',
  application: 'Création de votre outil sur mesure',
  indecis: 'Un point sur votre présence en ligne',
};

/** Raison affichée avec le chantier de création, par intention. */
const RAISONS_CREATION: Record<IntentionSansSite, string> = {
  vitrine:
    'Vous n’avez rien en ligne aujourd’hui : on commence par vous rendre trouvable.',
  boutique:
    'Vous n’avez rien en ligne aujourd’hui : on vous met en capacité de vendre.',
  application:
    'Vous n’avez rien en ligne aujourd’hui : on part de votre façon de travailler.',
  indecis: 'On cadrera ensemble ce qui vous servira vraiment.',
};

export function recommandations(q: Qualification): Recommandation[] {
  const out: Recommandation[] = [];

  // ── Site / application web ────────────────────────────────────────────────
  if (q.siteActuel === 'oui') {
    if (q.intentionSiteExistant === 'refonte') {
      out.push({
        id: 'refonte',
        titre: 'Refonte de votre site',
        raison: 'Votre site existe mais mérite une nouvelle version.',
        nature: 'chantier',
      });
    }
    if (q.intentionSiteExistant === 'application') {
      out.push({
        id: 'application',
        titre: 'Application web sur mesure',
        raison: 'Vous voulez dépasser le site vitrine.',
        nature: 'chantier',
      });
    }
    if (q.intentionSiteExistant === 'satisfait') {
      // « Mon site me convient » ne produisait RIEN. C'est pourtant
      // l'occasion en or d'offrir un regard extérieur : c'est gratuit pour
      // le client, ça ne l'engage à rien, et ça ouvre la conversation avec
      // le seul profil qui, sinon, sortait du parcours les mains vides.
      out.push({
        id: 'audit',
        titre: 'Un regard neuf sur votre site',
        raison:
          'Votre site vous convient. En 15 minutes on vous dit ce qui le freine, sans engagement.',
        nature: 'chantier',
      });
    }
  }

  if (q.siteActuel === 'non') {
    const intention = q.intentionSansSite;
    if (intention) {
      out.push({
        id: 'creation',
        titre: LIBELLES_CREATION[intention],
        raison: RAISONS_CREATION[intention],
        nature: 'chantier',
      });
    }
  }

  // ── Rester en contact avec ses clients ────────────────────────────────────
  if (q.emailing === 'liste-existante' || q.emailing === 'depuis-zero') {
    out.push({
      id: 'notifuse',
      suffixe: '.mail',
      titre: 'Veridian Mail',
      raison:
        q.emailing === 'liste-existante'
          ? 'Vous avez déjà des contacts : ils sont exploitables tout de suite.'
          : 'On part de zéro, l’outil s’occupe du reste.',
      nature: 'app',
    });
  } else if (q.prospection === 'b2c') {
    // Le client vend aux particuliers et a repoussé l'emailing : c'est
    // justement le terrain où la relance par email marche le mieux
    // (fidélisation, offres saisonnières). On requalifie la proposition au
    // lieu de l'omettre.
    out.push({
      id: 'notifuse',
      suffixe: '.mail',
      titre: 'Veridian Mail',
      raison:
        'Vos clients sont des particuliers : un email au bon moment les fait revenir, et ça se prépare à l’avance.',
      nature: 'app',
    });
  }

  // ── Recherche de clients professionnels ───────────────────────────────────
  if (q.prospection === 'priorite' || q.prospection === 'explorer') {
    out.push({
      id: 'prospection',
      suffixe: '.prospection',
      titre: 'Veridian Prospection',
      raison:
        q.prospection === 'priorite'
          ? 'Trouver des clients est votre priorité.'
          : 'À explorer : la base est déjà là, sans engagement.',
      nature: 'app',
    });
  }

  // ── Le client vend aux particuliers ──────────────────────────────────────
  // `b2c` était capté puis jeté : `recommandations()` ne testait que
  // `priorite` et `explorer`, donc « je vends aux particuliers » et « pas
  // maintenant » étaient traités à l'identique. C'est pourtant
  // l'information la plus segmentante du questionnaire — un client qui vend
  // aux particuliers n'achètera jamais la base d'entreprises, mais c'est le
  // meilleur profil pour la visibilité locale.
  if (q.prospection === 'b2c') {
    out.push({
      id: 'visibilite-locale',
      titre: 'Être trouvé par les particuliers de votre secteur',
      raison:
        'Vos clients sont des particuliers : ils vous cherchent sur Google et sur les cartes, c’est là qu’il faut être.',
      nature: 'chantier',
    });
  }

  // ── Analytics : le socle, jamais un lot de consolation ────────────────────
  // Ancienne formule : « Aucun chantier dans l'immédiat : commençons par
  // mesurer ce que fait votre audience. » On écrivait au prospect qu'il n'y
  // avait rien à faire avec nous. Elle est supprimée : Analytics est proposé
  // comme un point de départ concret.
  if (out.length === 0) {
    out.push({
      id: 'analytics',
      suffixe: '.analytics',
      titre: 'Veridian Analytics',
      raison:
        'Votre site tourne. On commence par regarder ce qu’il vous rapporte vraiment : d’où viennent vos visiteurs, ce qu’ils cherchent, ce qu’ils ne trouvent pas.',
      nature: 'app',
    });
  }

  return out;
}

/** Le parcours a-t-il déclenché au moins un chantier à cadrer avec Robert ? */
export function aUnChantier(q: Qualification): boolean {
  return recommandations(q).some((r) => r.nature === 'chantier');
}

/**
 * Les chantiers pour lesquels une DATE a du sens.
 *
 * On exclut volontairement le regard neuf (`audit`) et la visibilité locale :
 * ce sont des ouvertures de conversation, pas des projets datés. Demander
 * « c'est pour quand ? » à quelqu'un qui vient de répondre « mon site me
 * convient » n'aurait aucun sens et donnerait l'impression qu'on n'a pas
 * écouté sa réponse.
 */
const CHANTIERS_DATABLES = ['refonte', 'application', 'creation'];

/** Faut-il demander l'échéance ? (question 5, affichée sinon jamais) */
export function aUnChantierDatable(q: Qualification): boolean {
  return recommandations(q).some(
    (r) => r.nature === 'chantier' && CHANTIERS_DATABLES.includes(r.id),
  );
}
