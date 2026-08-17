/**
 * Tests de `questions.ts` — le branchement conditionnel du parcours.
 *
 * `ecransPertinents()` décide combien d'écrans le client voit et lesquels.
 * C'était, avec `recommandations()`, l'un des deux seuls endroits du lot qui
 * contiennent de la vraie logique métier, et il n'avait aucun test.
 *
 * On vérifie surtout ce qui casse en silence : le passage de 3 à 4 écrans
 * selon la branche, l'unicité des identifiants (deux écrans partageaient
 * `'site-intention'`), et le fait qu'une réponse change bien la liste.
 */

import { describe, it, expect } from 'vitest';

import {
  ECRANS_QUESTIONS,
  ecransPertinents,
  repondre,
} from '@/components/onboarding/qualification/questions';
import { ILLUSTRATIONS } from '@/components/onboarding/qualification/illustrations';
import type { Qualification } from '@/components/onboarding/qualification/types';

const ids = (q: Qualification) => ecransPertinents(q).map((e) => e.id);

describe('ECRANS_QUESTIONS — intégrité du catalogue', () => {
  it('n’a AUCUN identifiant en double', () => {
    // 🔴 Régression verrouillée : les deux branches de la question 2
    // partageaient `'site-intention'`. Conséquences : la `key` React ne
    // remontait pas le composant en basculant oui→non (l'animation d'entrée
    // ne rejouait pas), `metadata.etapeCourante` ne pouvait pas désigner
    // l'écran à reprendre, et tout `find(e => e.id === x)` renvoyait
    // systématiquement la branche « j'ai un site ».
    const tous = ECRANS_QUESTIONS.map((e) => e.id);
    expect(new Set(tous).size).toBe(tous.length);
  });

  it('donne à chaque écran une clé d’illustration qui existe', () => {
    for (const ecran of ECRANS_QUESTIONS) {
      expect(ILLUSTRATIONS, ecran.id).toHaveProperty(ecran.illustration);
    }
  });

  it('donne à chaque écran des valeurs d’options uniques', () => {
    for (const ecran of ECRANS_QUESTIONS) {
      const valeurs = ecran.options.map((o) => o.value);
      expect(new Set(valeurs).size, ecran.id).toBe(valeurs.length);
    }
  });

  it('écrit sur la clé qu’il déclare, et relit ce qu’il a écrit', () => {
    // Le lien `cle` ↔ `lire` ↔ `ecrire` n'est pas garanti par le type seul :
    // rien n'empêche d'écrire sur une clé et de relire l'autre.
    for (const ecran of ECRANS_QUESTIONS) {
      const valeur = ecran.options[0].value;
      const apres = repondre(ecran, {}, valeur);
      expect(apres[ecran.cle], ecran.id).toBe(valeur);
      expect(ecran.lire(apres), ecran.id).toBe(valeur);
    }
  });

  it('n’utilise ni sigle ni jargon d’agence dans le texte visible', () => {
    // Le client type est un artisan ou un commerçant : « B2B » et
    // « back-office » ne veulent rien dire pour lui, et c'est justement lui
    // qui doit cocher ces options-là.
    const interdits = ['b2b', 'b2c', 'back-office', 'backoffice'];
    for (const ecran of ECRANS_QUESTIONS) {
      const textes = [
        ecran.sousTitre ?? '',
        ...ecran.options.flatMap((o) => [o.label, o.description]),
      ]
        .join(' ')
        .toLowerCase();
      for (const mot of interdits) {
        expect(textes, `${mot} dans ${ecran.id}`).not.toContain(mot);
      }
    }
  });

  it('ne formule aucun refus définitif dans les options', () => {
    // « J'ai déjà ce qu'il me faut » met dans la bouche du dirigeant « j'ai
    // assez de clients », ce qu'aucun ne pense — mais l'écrire ainsi rend le
    // clic confortable et referme le sujet pour de bon.
    const textes = ECRANS_QUESTIONS.flatMap((e) =>
      e.options.map((o) => `${o.label} ${o.description}`),
    ).join(' | ');
    expect(textes).not.toContain('J’ai déjà ce qu’il me faut');
    expect(textes).not.toContain('Ce n’est pas le sujet du moment');
  });
});

describe('ecransPertinents — branchement', () => {
  it('ne montre que la première question tant que rien n’est répondu', () => {
    // Les deux branches de la question 2 sont conditionnées, l'échéance
    // aussi : sur un état vierge, il reste le socle inconditionnel.
    expect(ids({})).toEqual(['site-actuel', 'emailing', 'prospection']);
  });

  it('ouvre la branche « j’ai un site » et ferme l’autre', () => {
    const liste = ids({ siteActuel: 'oui' });
    expect(liste).toContain('site-intention-existant');
    expect(liste).not.toContain('site-intention-creation');
  });

  it('ouvre la branche « je n’ai pas de site » et ferme l’autre', () => {
    const liste = ids({ siteActuel: 'non' });
    expect(liste).toContain('site-intention-creation');
    expect(liste).not.toContain('site-intention-existant');
  });

  it('place la question de branche en 2e position, quelle que soit la branche', () => {
    // Le client ne doit percevoir aucun branchement : la question arrive
    // toujours au même endroit.
    expect(ids({ siteActuel: 'oui' })[1]).toBe('site-intention-existant');
    expect(ids({ siteActuel: 'non' })[1]).toBe('site-intention-creation');
  });

  it('n’ajoute l’échéance QUE si un chantier daté est déclaré', () => {
    expect(ids({ siteActuel: 'oui', intentionSiteExistant: 'satisfait' })).not.toContain(
      'echeance',
    );
    expect(ids({ siteActuel: 'oui', intentionSiteExistant: 'refonte' })).toContain(
      'echeance',
    );
    expect(ids({ siteActuel: 'non', intentionSansSite: 'boutique' })).toContain(
      'echeance',
    );
  });

  it('passe bien de 3 à 5 écrans sur le chemin le plus long', () => {
    expect(ids({ siteActuel: 'oui', intentionSiteExistant: 'refonte' })).toEqual([
      'site-actuel',
      'site-intention-existant',
      'emailing',
      'prospection',
      'echeance',
    ]);
  });
});

describe('repondre — application d’une réponse', () => {
  it('invalide la suite quand le client change de branche', () => {
    // Sans ça, on garderait une réponse orpheline : le client dit « j'ai un
    // site », répond « refonte », revient et dit « non, pas de site » —
    // `intentionSiteExistant` resterait posé et produirait une
    // recommandation qui ne correspond à rien.
    const site = ECRANS_QUESTIONS[0];
    const avec: Qualification = {
      siteActuel: 'oui',
      intentionSiteExistant: 'refonte',
      emailing: 'depuis-zero',
    };
    const apres = repondre(site, avec, 'non');

    expect(apres.siteActuel).toBe('non');
    expect(apres.intentionSiteExistant).toBeUndefined();
    expect(apres.intentionSansSite).toBeUndefined();
    // Les réponses hors branche, elles, sont conservées.
    expect(apres.emailing).toBe('depuis-zero');
  });

  it('ne mute jamais l’état reçu', () => {
    const avant: Qualification = { emailing: 'plus-tard' };
    const emailing = ECRANS_QUESTIONS.find((e) => e.id === 'emailing')!;
    repondre(emailing, avant, 'depuis-zero');
    expect(avant.emailing).toBe('plus-tard');
  });
});
