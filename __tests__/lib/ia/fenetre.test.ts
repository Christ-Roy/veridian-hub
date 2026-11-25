/**
 * La fenêtre du Hub (/ia/chat) : le tenant doit être à l'utilisateur, et le CRM n'en a plus (chat natif, 23/11).
 * Aucune valeur par défaut : chaque cas douteux est un refus visible.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ia/contexte', () => ({ espaceDe: vi.fn() }));

import { autoriserFenetre, MESSAGES_REFUS } from '@/lib/ia/fenetre';

const parTenant = vi.fn(async (_u: string, t: unknown) => (t === 'tenant-robert' ? { id: 'tenant-robert', slug: 'r', workspaceId: null } : null));

describe('autoriserFenetre', () => {
  it('Academy : le tenant doit être à l\'utilisateur ; sans tenant, refus', async () => {
    expect(await autoriserFenetre({ app: 'academy', tenant: 'tenant-autre', hubUserId: 'hub-robert', preuve: { par: 'session' } }, { espaceDe: parTenant })).toEqual({ ok: false, refus: 'espace_etranger' });
    expect((await autoriserFenetre({ app: 'academy', hubUserId: 'hub-robert', preuve: { par: 'session' } }, { espaceDe: parTenant })).ok).toBe(false);
    expect(await autoriserFenetre({ app: 'academy', tenant: 'tenant-robert', hubUserId: 'hub-robert', preuve: { par: 'session' } }, { espaceDe: parTenant })).toEqual({
      ok: true,
      espace: { id: 'tenant-robert', slug: 'r', workspaceId: null },
    });
  });

  it('CRM : refus nommé qui renvoie au chat natif, aucun espace cherché, même avec un tenant valide', async () => {
    parTenant.mockClear();
    expect(await autoriserFenetre({ app: 'crm', tenant: 'tenant-robert', hubUserId: 'hub-robert', preuve: { par: 'session' } }, { espaceDe: parTenant })).toEqual({ ok: false, refus: 'chat_natif' });
    expect(parTenant).not.toHaveBeenCalled();
    expect(MESSAGES_REFUS.chat_natif).toContain('Nouveau chat IA');
  });
});
