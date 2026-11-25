// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { federationExpiree, glisser, joursValables, SESSION_FEDEREE_MAX_S, SESSION_FEDEREE_S } from '@/lib/federation/duree';

const N = 2_000_000_000;
const J = 86_400;
const f = (x: object, jours?: number | null) => federationExpiree(x, N, jours);

describe('federationExpiree', () => {
  it('sans réglage : 24 h depuis la connexion réelle ; une session ordinaire ne tombe pas ; sans début connu, expirée', () => {
    expect([f({ federe: true, authAt: N - SESSION_FEDEREE_S }), f({ federe: true, authAt: N - SESSION_FEDEREE_S - 1 }), f({ federe: true }), f({ authAt: 0 }), f({ federe: 'true', authAt: 0 })]).toEqual([false, true, true, false, false]);
  });
  it('sept jours glissants : l\'usage la garde, sept jours sans usage la finissent', () => {
    const s = (vu: number, auth = 20 * J) => f({ federe: true, authAt: N - auth, federeVu: N - vu, federeJours: 7 });
    expect([s(6 * J), s(7 * J), s(7 * J + 1)]).toEqual([false, false, true]);
  });
  it('jamais plus de trente jours depuis la connexion réelle, même utilisée à l\'instant', () => {
    expect([f({ federe: true, authAt: N - SESSION_FEDEREE_MAX_S, federeVu: N, federeJours: 30 }), f({ federe: true, authAt: N - SESSION_FEDEREE_MAX_S - 1, federeVu: N, federeJours: 30 })]).toEqual([false, true]);
  });
  it('le réglage relu en base l\'emporte sur celui du jeton, dans les deux sens', () => {
    const x = { federe: true, authAt: N - 3 * J, federeVu: N, federeJours: 7 };
    expect([f(x, null), f(x, 7), f({ ...x, federeJours: undefined }, 7)]).toEqual([true, false, false]);
  });
});
it('joursValables : 2 à 30, entier ; le reste vaut 24 h', () => expect([1, 2, 30, 31, 2.5, '7', null, undefined, NaN].map(joursValables)).toEqual([null, 2, 30, null, null, null, null, null, null]));
describe('glisser', () => {
  const x = { federe: true, authAt: N - 3 * J, federeVu: N - 2 * J, federeJours: 7 };
  it('renouvelle « vue », une fois par heure', () => expect([glisser(x, N).federeVu, glisser({ ...x, federeVu: N - 60 }, N).federeVu]).toEqual([N, N - 60]));
  it('ne ressuscite rien, ne touche ni une session ordinaire ni celle de 24 h', () => {
    const morte = { ...x, federeVu: N - 8 * J };
    const ordinaire = { authAt: 1 };
    const jour = { federe: true, authAt: N - 60 };
    expect([glisser(morte, N), glisser(ordinaire, N), glisser(jour, N)]).toEqual([morte, ordinaire, jour]);
    expect(glisser(morte, N)).toBe(morte);
  });
});
