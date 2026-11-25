// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { emprunteurDe, empruntSigne, ouvrirEmprunt, raisonPropre, suiteEmprunt } from '@/lib/emprunt/journal';

const cible = { id: 'u-c', hubUserId: 'h-c', email: 'c@c' };
describe('ouvrirEmprunt', () => {
  it('écrit qui, chez qui, pourquoi ; une écriture ratée lève (sans trace, pas d\'entrée)', async () => {
    const create = vi.fn(async () => ({ id: 'e-1' }));
    expect(await ouvrirEmprunt({ auditLog: { create } } as never, { par: 'h-a', acteur: 'admin:a', cible, raison: ' a\n b ', via: 'ecran' })).toBe('e-1');
    expect((create.mock.calls[0] as unknown as [{ data: object }])[0].data).toMatchObject({ action: 'admin.impersonate.start', actor: 'admin:a', targetId: 'u-c', payload: { par: 'h-a', raison: 'a b', hubUserId: 'h-c' } });
    await expect(ouvrirEmprunt({ auditLog: { create: async () => { throw new Error('panne'); } } } as never, { par: 'x', acteur: 'x', cible, via: 'lien' })).rejects.toThrow('panne');
  });
});
it('raisonPropre : vide ou autre chose qu\'un texte = rien ; bornée', () => expect([raisonPropre(' '), raisonPropre(3), raisonPropre(null), raisonPropre('x'.repeat(900))?.length]).toEqual([null, null, null, 300]));
it('emprunteurDe : seulement d\'une ouverture écrite', async () => {
  const lire = (l: unknown) => emprunteurDe({ auditLog: { findUnique: async () => l } } as never, 'e');
  expect(await Promise.all([{ action: 'admin.impersonate.start', payload: { par: 'h' } }, { action: 'admin.impersonate.consume', payload: { par: 'h' } }, { action: 'admin.impersonate.start', payload: null }, null].map(lire))).toEqual(['h', null, null, null]);
});
it('suiteEmprunt se rattache à l\'ouverture', async () => {
  const create = vi.fn(async () => ({}));
  await suiteEmprunt({ auditLog: { create } } as never, { action: 'app', empruntId: 'e-1', par: 'h-a', userId: 'u-c', detail: { app: 'crm' } });
  expect((create.mock.calls[0] as unknown as [{ data: object }])[0].data).toMatchObject({ action: 'admin.impersonate.app', actor: 'hub_user:h-a', payload: { emprunt: 'e-1', app: 'crm' } });
});
describe('empruntSigne', () => {
  it('l\'emprunt, l\'emprunteur et la fin ; jamais une adresse ni la raison ; rien d\'une session ordinaire', () => {
    expect(empruntSigne({ impersonated: true, impersonatedBy: 'h', empruntId: 'x', authAt: 1_000 })).toEqual({ id: 'x', par: 'h', expire_le: new Date(4_600_000).toISOString() });
    for (const u of [undefined, {}, { impersonated: true }, { impersonated: true, impersonatedBy: 'h', authAt: 1 }, { impersonatedBy: 'h', empruntId: 'x', authAt: 1 }]) expect(empruntSigne(u)).toBeNull();
  });
});
