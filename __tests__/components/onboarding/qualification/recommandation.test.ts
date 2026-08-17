/**
 * Tests de `recommandation.ts` — la seule vraie logique métier du parcours.
 *
 * C'est elle qui décide ce que le client voit sur l'écran final, et demain ce
 * qu'on provisionne pour lui. Elle n'avait AUCUN test : on couvre ici la
 * table de cas complète (elle est petite, c'est instantané) plutôt que trois
 * chemins choisis à la main.
 *
 * Deux invariants portent tout le reste, et ce sont des règles commerciales,
 * pas des détails techniques :
 *   1. aucune combinaison de réponses ne produit une liste vide ;
 *   2. aucune raison n'annonce au prospect qu'il n'y a rien à faire avec nous.
 */

import { describe, it, expect } from 'vitest';

import {
  aUnChantier,
  aUnChantierDatable,
  recommandations,
} from '@/components/onboarding/qualification/recommandation';
import type {
  Echeance,
  IntentionSansSite,
  IntentionSiteExistant,
  InteretEmailing,
  InteretProspection,
  Qualification,
  SiteActuel,
} from '@/components/onboarding/qualification/types';

const SITES: SiteActuel[] = ['oui', 'non'];
const EXISTANT: IntentionSiteExistant[] = ['satisfait', 'refonte', 'application'];
const SANS_SITE: IntentionSansSite[] = ['vitrine', 'boutique', 'application', 'indecis'];
const EMAILING: InteretEmailing[] = ['liste-existante', 'depuis-zero', 'plus-tard'];
const PROSPECTION: InteretProspection[] = ['priorite', 'explorer', 'b2c', 'plus-tard'];
const ECHEANCES: (Echeance | undefined)[] = [undefined, 'urgent', 'trimestre', 'sans-date'];

/** Toutes les combinaisons atteignables du questionnaire. */
function toutesLesCombinaisons(): Qualification[] {
  const out: Qualification[] = [];
  for (const siteActuel of SITES) {
    const intentions: (IntentionSiteExistant | IntentionSansSite)[] =
      siteActuel === 'oui' ? EXISTANT : SANS_SITE;
    for (const intention of intentions) {
      for (const emailing of EMAILING) {
        for (const prospection of PROSPECTION) {
          for (const echeance of ECHEANCES) {
            out.push({
              siteActuel,
              ...(siteActuel === 'oui'
                ? { intentionSiteExistant: intention as IntentionSiteExistant }
                : { intentionSansSite: intention as IntentionSansSite }),
              emailing,
              prospection,
              echeance,
            });
          }
        }
      }
    }
  }
  return out;
}

describe('recommandations — invariants sur toutes les combinaisons', () => {
  const combinaisons = toutesLesCombinaisons();

  it('couvre bien la totalité du questionnaire', () => {
    // (2 branches : 3 ou 4 intentions) × 3 emailing × 4 prospection × 4 échéances
    expect(combinaisons).toHaveLength((3 + 4) * 3 * 4 * 4);
  });

  it('ne renvoie JAMAIS une liste vide', () => {
    for (const q of combinaisons) {
      expect(recommandations(q).length, JSON.stringify(q)).toBeGreaterThan(0);
    }
  });

  it('n’annonce jamais au prospect qu’il n’y a rien à faire avec nous', () => {
    // Formulation supprimée : « Aucun chantier dans l'immédiat ». On
    // formalisait à la place du client la conclusion « je n'ai pas besoin de
    // Veridian », sur l'écran où il est le plus chaud.
    for (const q of combinaisons) {
      for (const r of recommandations(q)) {
        expect(r.raison.toLowerCase(), JSON.stringify(q)).not.toContain(
          'aucun chantier',
        );
      }
    }
  });

  it('n’utilise aucun sigle ni jargon d’agence dans les libellés', () => {
    const interdits = ['b2b', 'b2c', 'back-office', 'backoffice', 'crm', 'saas'];
    for (const q of combinaisons) {
      for (const r of recommandations(q)) {
        const texte = `${r.titre} ${r.raison}`.toLowerCase();
        for (const mot of interdits) {
          expect(texte, `${mot} dans « ${r.titre} »`).not.toContain(mot);
        }
      }
    }
  });

  it('ne produit jamais deux fois le même identifiant', () => {
    // Deux lignes de même id casseraient la `key` React du récapitulatif.
    for (const q of combinaisons) {
      const ids = recommandations(q).map((r) => r.id);
      expect(new Set(ids).size, JSON.stringify(q)).toBe(ids.length);
    }
  });
});

describe('recommandations — branche « j’ai déjà un site »', () => {
  it('propose une refonte quand le client veut refaire son site', () => {
    const out = recommandations({ siteActuel: 'oui', intentionSiteExistant: 'refonte' });
    expect(out.find((r) => r.id === 'refonte')?.nature).toBe('chantier');
  });

  it('propose une application quand le client veut aller plus loin', () => {
    const out = recommandations({
      siteActuel: 'oui',
      intentionSiteExistant: 'application',
    });
    expect(out.find((r) => r.id === 'application')?.nature).toBe('chantier');
  });

  it('propose un regard neuf quand le site convient au client', () => {
    // Avant, `satisfait` ne produisait STRICTEMENT rien : le client sortait
    // du parcours les mains vides alors que c'est l'occasion en or d'offrir
    // un audit gratuit.
    const out = recommandations({
      siteActuel: 'oui',
      intentionSiteExistant: 'satisfait',
    });
    const audit = out.find((r) => r.id === 'audit');
    expect(audit).toBeDefined();
    expect(audit?.raison).toMatch(/sans engagement/);
  });
});

describe('recommandations — branche « je n’ai pas de site »', () => {
  it('donne un libellé propre à chaque intention, jamais le repli', () => {
    // `Record<IntentionSansSite, string>` : une intention ajoutée à l'union
    // casserait la compilation ici plutôt que d'afficher silencieusement
    // « Un point sur votre présence en ligne ».
    const attendus: Record<IntentionSansSite, RegExp> = {
      vitrine: /site vitrine/i,
      boutique: /boutique en ligne/i,
      application: /outil sur mesure/i,
      indecis: /présence en ligne/i,
    };
    for (const intention of SANS_SITE) {
      const out = recommandations({ siteActuel: 'non', intentionSansSite: intention });
      const creation = out.find((r) => r.id === 'creation');
      expect(creation?.titre, intention).toMatch(attendus[intention]);
    }
  });

  it('adoucit la raison quand le client ne sait pas encore', () => {
    const out = recommandations({ siteActuel: 'non', intentionSansSite: 'indecis' });
    expect(out.find((r) => r.id === 'creation')?.raison).toMatch(/ensemble/);
  });

  it('ne propose rien de la branche tant que l’intention n’est pas donnée', () => {
    const out = recommandations({ siteActuel: 'non' });
    expect(out.find((r) => r.id === 'creation')).toBeUndefined();
  });
});

describe('recommandations — « je vends aux particuliers » n’est plus jeté', () => {
  // `recommandations()` ne testait que `priorite` et `explorer` : `b2c` et
  // `plus-tard` tombaient dans le vide et étaient traités à l'identique.
  // C'était une perte sèche — c'est l'information la plus segmentante du
  // questionnaire.

  it('propose la visibilité locale', () => {
    const out = recommandations({ prospection: 'b2c' });
    const local = out.find((r) => r.id === 'visibilite-locale');
    expect(local?.nature).toBe('chantier');
    expect(local?.raison).toMatch(/cartes/);
  });

  it('requalifie l’emailing au lieu de l’omettre quand il a été repoussé', () => {
    const out = recommandations({ prospection: 'b2c', emailing: 'plus-tard' });
    const mail = out.find((r) => r.id === 'notifuse');
    expect(mail).toBeDefined();
    expect(mail?.raison).toMatch(/particuliers/);
  });

  it('ne double PAS la ligne emailing quand le client en veut déjà', () => {
    const out = recommandations({ prospection: 'b2c', emailing: 'liste-existante' });
    expect(out.filter((r) => r.id === 'notifuse')).toHaveLength(1);
  });

  it('ne propose jamais la base d’entreprises à un client B2C', () => {
    const out = recommandations({ prospection: 'b2c' });
    expect(out.find((r) => r.id === 'prospection')).toBeUndefined();
  });

  it('distingue « je vends aux particuliers » de « pas maintenant »', () => {
    const b2c = recommandations({ prospection: 'b2c' }).map((r) => r.id);
    const plusTard = recommandations({ prospection: 'plus-tard' }).map((r) => r.id);
    expect(b2c).not.toEqual(plusTard);
  });
});

describe('recommandations — le filet Analytics', () => {
  it('sort quand aucune autre recommandation ne s’applique', () => {
    const out = recommandations({});
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('analytics');
  });

  it('formule Analytics comme un point de départ, pas comme un lot de consolation', () => {
    const raison = recommandations({}).find((r) => r.id === 'analytics')?.raison ?? '';
    expect(raison).toMatch(/Votre site tourne/);
    expect(raison).not.toMatch(/aucun/i);
  });

  it('s’efface dès qu’une vraie recommandation existe', () => {
    const out = recommandations({ emailing: 'depuis-zero' });
    expect(out.find((r) => r.id === 'analytics')).toBeUndefined();
  });

  it('couvre le profil « tout va bien » qui sortait sans rien', () => {
    // Le parcours vécu qui posait problème : site satisfaisant, emailing
    // repoussé, vend aux particuliers. Il ne donnait qu'une ligne, celle qui
    // disait qu'il n'y avait rien à faire.
    const out = recommandations({
      siteActuel: 'oui',
      intentionSiteExistant: 'satisfait',
      emailing: 'plus-tard',
      prospection: 'b2c',
    });
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.map((r) => r.id)).toEqual(
      expect.arrayContaining(['audit', 'notifuse', 'visibilite-locale']),
    );
  });
});

describe('aUnChantier / aUnChantierDatable', () => {
  it('aUnChantier est vrai dès qu’une ligne est à cadrer avec Robert', () => {
    expect(aUnChantier({ siteActuel: 'oui', intentionSiteExistant: 'refonte' })).toBe(true);
    expect(aUnChantier({ emailing: 'depuis-zero' })).toBe(false);
  });

  it('aUnChantierDatable ne s’allume que sur un vrai projet daté', () => {
    // On ne demande pas « c'est pour quand ? » à quelqu'un qui vient de dire
    // « mon site me convient » : ça donnerait l'impression de ne pas l'avoir
    // écouté.
    expect(
      aUnChantierDatable({ siteActuel: 'oui', intentionSiteExistant: 'refonte' }),
    ).toBe(true);
    expect(
      aUnChantierDatable({ siteActuel: 'non', intentionSansSite: 'vitrine' }),
    ).toBe(true);
    expect(
      aUnChantierDatable({ siteActuel: 'oui', intentionSiteExistant: 'satisfait' }),
    ).toBe(false);
    expect(aUnChantierDatable({ prospection: 'b2c' })).toBe(false);
    expect(aUnChantierDatable({})).toBe(false);
  });
});
