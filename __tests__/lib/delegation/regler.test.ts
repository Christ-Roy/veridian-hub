// @vitest-environment node
/** L'écran et l'IA règlent par le même chemin : sans abonnement chez la source, une liaison d'événement ne reste pas allumée. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ regler: vi.fn(), suivre: vi.fn() }));
vi.mock('@/lib/delegation/interrupteur', () => ({ reglerIntegration: (...a: unknown[]) => m.regler(...a) }));
vi.mock('@/lib/evenements/allumage', () => ({ suivreAbonnement: (...a: unknown[]) => m.suivre(...a) }));

import { reglerEtSuivre } from '@/lib/delegation/regler';

const d = (etat: 'allumee' | 'eteinte') => ({ tenantId: 'T', paire: 'notifuse>crm', etat, hubUserId: 'u', client: 'Claude', origine: 'https://h' });
beforeEach(() => {
  vi.clearAllMocks();
  m.regler.mockImplementation(async (_db: unknown, x: { etat: string }) => ({ etat: x.etat }));
  m.suivre.mockResolvedValue('fait');
});

describe('reglerEtSuivre', () => {
  it('l\'abonnement suit l\'état obtenu', async () => {
    expect(await reglerEtSuivre({} as never, d('allumee'))).toEqual({ etat: 'allumee' });
    expect(await reglerEtSuivre({} as never, d('eteinte'))).toEqual({ etat: 'eteinte' });
    expect(m.suivre.mock.calls.map((c) => c[1])).toEqual([{ tenantId: 'T', paire: 'notifuse>crm', actif: true }, { tenantId: 'T', paire: 'notifuse>crm', actif: false }]);
  });
  it('à confirmer ou refusé : la source n\'est pas appelée', async () => {
    for (const r of [{ etat: 'a_confirmer', lien: 'l', expire_le: 'e' }, { refus: 'role_insuffisant' }]) {
      m.regler.mockResolvedValueOnce(r);
      expect(await reglerEtSuivre({} as never, d('allumee'))).toEqual(r);
    }
    expect(m.suivre).not.toHaveBeenCalled();
  });
  it('source muette : éteinte aussitôt et dite ; couper passe quand même', async () => {
    m.suivre.mockResolvedValue('echec');
    expect(await reglerEtSuivre({} as never, d('allumee'))).toEqual({ refus: 'source_injoignable' });
    expect(m.regler.mock.calls.map((c) => (c[1] as { etat: string }).etat)).toEqual(['allumee', 'eteinte']);
    expect(await reglerEtSuivre({} as never, d('eteinte'))).toEqual({ etat: 'eteinte' });
  });
});
