/** La règle commune de la fenêtre (lib/ia/etat-fenetre.ts) : éteinte d'abord, puis le moteur, puis l'abonnement ouvert dans l'espace. */
import { describe, expect, it } from 'vitest';

import { APPS_CHAT, estAppFenetre } from '@/lib/ia/branchements';
import { APPS_FENETRE, etatFenetre } from '@/lib/ia/etat-fenetre';

const T = { hubUserId: 'u', app: 'academy', tenantId: 't' };
const base = (o: { active?: boolean | null; moteurs?: string[] }) => ({
  iaActivation: { findUnique: async () => (o.active === null || o.active === undefined ? null : { enabled: o.active }) },
  iaBranchement: {
    findFirst: async (q: { where: { moteur?: string } }) => {
      const l = (o.moteurs ?? []).filter((x) => !q.where.moteur || x === q.where.moteur);
      return l.length ? { moteur: l[0] } : null;
    },
  },
  tenant: { findUnique: async () => null },
});

describe('etatFenetre', () => {
  it('sans moteur, avec une clé, éteinte, abonnement fermé ou ouvert dans l\'espace', async () => {
    const ouvert = async () => true;
    const ferme = async () => false;
    expect([
      await etatFenetre(base({}) as never, T),
      await etatFenetre(base({ moteurs: ['cle-api'] }) as never, T),
      await etatFenetre(base({ active: false, moteurs: ['cle-api'] }) as never, T),
      await etatFenetre(base({ moteurs: ['claude-code-abonnement'] }) as never, T, { atelierOuvert: ferme }),
      await etatFenetre(base({ moteurs: ['claude-code-abonnement'] }) as never, T, { atelierOuvert: ouvert }),
    ]).toEqual(['sans_moteur', 'prete', 'eteinte', 'sans_moteur', 'prete']);
  });
});

describe('APPS_FENETRE', () => {
  it('exactement les apps qui ont une fenêtre au Hub : le CRM (chat natif) n\'y est pas, aucune ne manque', () => {
    expect([...APPS_FENETRE].sort()).toEqual(APPS_CHAT.filter((a) => estAppFenetre(a)).sort());
    expect((APPS_FENETRE as readonly string[]).includes('crm')).toBe(false);
  });
});
