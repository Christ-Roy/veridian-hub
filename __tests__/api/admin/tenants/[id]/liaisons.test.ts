// @vitest-environment node
/** Lecture des liaisons d'une organisation : admin seulement, aucune personne rendue, aucune écriture. */
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ refus: vi.fn(), lister: vi.fn(), tenant: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.refus(...a) }));
vi.mock('@/lib/delegation/interrupteur', () => ({ listerIntegrations: (...a: unknown[]) => m.lister(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { tenant: { findFirst: (...a: unknown[]) => m.tenant(...a) } } }));

import { GET } from '@/app/api/admin/tenants/[id]/liaisons/route';

const T = '11111111-1111-4111-8111-111111111111';
const appel = (id = T) => GET(new NextRequest(`http://x/api/admin/tenants/${id}/liaisons`), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  m.refus.mockResolvedValue(null);
  m.tenant.mockResolvedValue({ id: T });
  m.lister.mockResolvedValue([{ paire: 'crm>notifuse', etat: 'allumee', par_defaut: true, change_par: null }, { paire: 'crm>notifuse#sequences', etat: 'eteinte', par_defaut: false, change_par: 'quelqu.un@client.fr' }]);
});

it('rend l\'état de chaque liaison, sans aucune adresse', async () => {
  const r = await appel();
  const j = await r.json();
  expect([r.status, j.liaisons.map((l: { paire: string; etat: string; reglee_par_quelqu_un: boolean }) => [l.paire, l.etat, l.reglee_par_quelqu_un])]).toEqual([200, [['crm>notifuse', 'allumee', false], ['crm>notifuse#sequences', 'eteinte', true]]]);
  expect(JSON.stringify(j)).not.toContain('@');
});
it('refus de l\'admin, identifiant invalide, organisation inconnue : rien n\'est lu', async () => {
  m.refus.mockResolvedValueOnce(NextResponse.json({ error: 'x' }, { status: 401 }));
  const statuts = [(await appel()).status, (await appel('pas-un-id')).status];
  m.tenant.mockResolvedValueOnce(null);
  statuts.push((await appel()).status);
  expect(statuts).toEqual([401, 400, 404]);
  expect(m.lister).not.toHaveBeenCalled();
});
