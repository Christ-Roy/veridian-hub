/**
 * espaceDe (lib/ia/contexte.ts) : l'espace d'une question « Mon IA », désigné par le tenant Hub ou par le
 * workspace de l'app (Twenty). Jamais un espace qui n'est pas à l'utilisateur (menace « fuite entre tenants »).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const m = vi.hoisted(() => ({ espaces: vi.fn(), tenants: vi.fn() }));

vi.mock('@/lib/mcp/catalogue', () => ({ espacesDe: (...a: unknown[]) => m.espaces(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => m.tenants(...a) } } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: vi.fn(), userUuid: vi.fn() }));
vi.mock('@/lib/auth/email-proof', () => ({ isEmailProvenForSession: vi.fn() }));

import { espaceDe } from '@/lib/ia/contexte';

beforeEach(() => {
  m.espaces.mockResolvedValue([{ id: 't-a', slug: 'a' }]);
  // findMany est restreint aux ids de l'utilisateur : on le simule fidèlement.
  const lignes = [
    { id: 't-a', slug: 'a', metadata: { crm: { workspace_id: WS_A } } },
    { id: 't-b', slug: 'b', metadata: { crm: { workspace_id: WS_B } } },
  ];
  m.tenants.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => lignes.filter((l) => where.id.in.includes(l.id)));
});

describe('espaceDe', () => {
  it('par tenant : le sien, avec son workspace CRM', async () => {
    expect(await espaceDe('u', 't-a', { app: 'crm', workspaceId: undefined })).toEqual({ id: 't-a', slug: 'a', workspaceId: WS_A });
  });
  it('par workspace Twenty : le tenant de l\'utilisateur qui le porte', async () => {
    expect(await espaceDe('u', undefined, { app: 'crm', workspaceId: WS_A })).toMatchObject({ id: 't-a' });
  });
  it("le workspace d'un autre client : rien", async () => {
    expect(await espaceDe('u', undefined, { app: 'crm', workspaceId: WS_B })).toBeNull();
    expect(await espaceDe('u', 't-b')).toBeNull();
  });
  it('tenant et workspace qui ne concordent pas : rien', async () => {
    m.espaces.mockResolvedValue([{ id: 't-a' }, { id: 't-b' }]);
    expect(await espaceDe('u', 't-a', { app: 'crm', workspaceId: WS_B })).toBeNull();
  });
  it('workspace mal formé ou sans app : rien', async () => {
    expect(await espaceDe('u', undefined, { app: 'crm', workspaceId: "' OR 1=1" })).toBeNull();
    expect(await espaceDe('u', undefined, { app: '', workspaceId: WS_A })).toBeNull();
    expect(await espaceDe('u', undefined)).toBeNull();
  });
});
