// @vitest-environment node
/** La première question à une IA ne crée pas un espace personnel à un salarié. */
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ crm: vi.fn(), academy: vi.fn(), seul: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/crm/provision', () => ({ ensureCrmWorkspace: (...a: unknown[]) => m.crm(...a) }));
vi.mock('@/lib/academy/provision', () => ({ ensureAcademyWorkspace: (...a: unknown[]) => m.academy(...a) }));
vi.mock('@/lib/tenants/membre-seul', () => ({ membreSeul: (...a: unknown[]) => m.seul(...a) }));

import { provisionneursParDefaut } from '@/lib/mcp/provisionneurs';

const QUI = { hubUserId: 'h', email: 'a@b.c', name: 'A', clientId: 'c' } as never;
beforeEach(() => { vi.clearAllMocks(); m.crm.mockResolvedValue({ ok: true }); m.academy.mockResolvedValue({ ok: true }); });
it.each([[false, true, 1], [true, false, 0]])('salarié %s : créé %s', async (seul, cree, appels) => {
  m.seul.mockResolvedValue(seul);
  const p = await provisionneursParDefaut();
  expect([await p.twenty(QUI), await p.academy(QUI), m.crm.mock.calls.length, m.academy.mock.calls.length]).toEqual([cree, cree, appels, appels]);
});
