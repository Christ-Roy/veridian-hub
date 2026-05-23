/**
 * Tests unitaires de `discoverAppsByEmail` (lib/discovery/aggregate.ts).
 *
 * Couvre :
 *   - email inconnu → exists=false + tenants=[]
 *   - user sans supabaseUserId → exists=true + tenants=[] (cas dégradé)
 *   - user owner mono-app (Notifuse seul)
 *   - user owner mono-app (Prospection seul)
 *   - user owner multi-app (Notifuse + Prospection)
 *   - user member d'un workspace d'un autre owner
 *   - dédup quand un user est owner d'un tenant ET membre d'un autre tenant
 *     sur la même app (gagne owner)
 *   - filtrage des tenants soft-deleted
 *   - filtrage des memberships soft-deleted
 *   - lookup case-insensitive de l'email
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverAppsByEmail } from '@/lib/discovery/aggregate';

type FakeUser = { id: string; email: string; supabaseUserId: string | null };
type FakeTenant = {
  id: string;
  userId: string;
  notifuseWorkspaceSlug: string | null;
  prospectionApiKey: string | null;
  deletedAt: Date | null;
};
type FakeMember = {
  tenantId: string;
  userId: string;
  role: string;
  deletedAt: Date | null;
};

const users: FakeUser[] = [];
const tenants: FakeTenant[] = [];
const members: FakeMember[] = [];

const prisma = {
  user: {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const u = users.find((u) => u.email === where.email);
      if (!u) return null;
      const out: any = {};
      for (const k of Object.keys(select ?? {})) out[k] = (u as any)[k];
      return out;
    }),
    findFirst: vi.fn(async ({ where, select }: any) => {
      const target =
        typeof where.email === 'string'
          ? where.email.toLowerCase()
          : where.email?.equals?.toLowerCase();
      const u = users.find((u) => u.email.toLowerCase() === target);
      if (!u) return null;
      const out: any = {};
      for (const k of Object.keys(select ?? {})) out[k] = (u as any)[k];
      return out;
    }),
  },
  tenant: {
    findMany: vi.fn(async ({ where, select }: any) => {
      const filtered = tenants.filter((t) => {
        if (where.deletedAt === null && t.deletedAt !== null) return false;
        if (where.userId && t.userId !== where.userId) return false;
        if (where.id?.in && !where.id.in.includes(t.id)) return false;
        return true;
      });
      return filtered.map((t) => {
        const out: any = {};
        for (const k of Object.keys(select ?? {})) out[k] = (t as any)[k];
        return out;
      });
    }),
  },
  tenantMember: {
    findMany: vi.fn(async ({ where, select }: any) => {
      const filtered = members.filter((m) => {
        if (where.deletedAt === null && m.deletedAt !== null) return false;
        if (where.userId && m.userId !== where.userId) return false;
        return true;
      });
      return filtered.map((m) => {
        const out: any = {};
        for (const k of Object.keys(select ?? {})) out[k] = (m as any)[k];
        return out;
      });
    }),
  },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  users.length = 0;
  tenants.length = 0;
  members.length = 0;
});

describe('discoverAppsByEmail', () => {
  it('returns exists=false when email unknown', async () => {
    const res = await discoverAppsByEmail(prisma, 'ghost@example.com');
    expect(res).toEqual({ exists: false, tenants: [] });
  });

  it('returns exists=true + empty tenants when user has no supabaseUserId', async () => {
    users.push({ id: 'u1', email: 'oauth@example.com', supabaseUserId: null });
    const res = await discoverAppsByEmail(prisma, 'oauth@example.com');
    expect(res).toEqual({ exists: true, tenants: [] });
  });

  it('owner mono-app Notifuse only', async () => {
    users.push({
      id: 'u1',
      email: 'alice@example.com',
      supabaseUserId: '00000000-0000-0000-0000-000000000001',
    });
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000001',
      notifuseWorkspaceSlug: 'alice-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'alice@example.com');
    expect(res.exists).toBe(true);
    expect(res.tenants).toEqual([{ app: 'notifuse', role: 'owner' }]);
  });

  it('owner mono-app Prospection only', async () => {
    users.push({
      id: 'u1',
      email: 'bob@example.com',
      supabaseUserId: '00000000-0000-0000-0000-000000000002',
    });
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000002',
      notifuseWorkspaceSlug: null,
      prospectionApiKey: 'sk_bob_xxx',
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'bob@example.com');
    expect(res.tenants).toEqual([{ app: 'prospection', role: 'owner' }]);
  });

  it('owner multi-app (Notifuse + Prospection on same tenant)', async () => {
    users.push({
      id: 'u1',
      email: 'carol@example.com',
      supabaseUserId: '00000000-0000-0000-0000-000000000003',
    });
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000003',
      notifuseWorkspaceSlug: 'carol-ws',
      prospectionApiKey: 'sk_carol_xxx',
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'carol@example.com');
    expect(res.tenants).toHaveLength(2);
    expect(res.tenants).toContainEqual({ app: 'notifuse', role: 'owner' });
    expect(res.tenants).toContainEqual({ app: 'prospection', role: 'owner' });
  });

  it('member of another owners workspace', async () => {
    const inviteeUuid = '00000000-0000-0000-0000-000000000099';
    users.push({
      id: 'u_invitee',
      email: 'dan@example.com',
      supabaseUserId: inviteeUuid,
    });
    // Tenant owned by someone else
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000010',
      notifuseWorkspaceSlug: 'owner-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    members.push({
      tenantId: 't1',
      userId: inviteeUuid,
      role: 'admin',
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'dan@example.com');
    expect(res.tenants).toEqual([{ app: 'notifuse', role: 'admin' }]);
  });

  it('owner takes precedence over member when both relations exist on same app', async () => {
    const uuid = '00000000-0000-0000-0000-000000000004';
    users.push({
      id: 'u1',
      email: 'eve@example.com',
      supabaseUserId: uuid,
    });
    // Eve owns tenant t1 (Notifuse)
    tenants.push({
      id: 't1',
      userId: uuid,
      notifuseWorkspaceSlug: 'eve-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    // Eve is also member of another Notifuse tenant t2
    tenants.push({
      id: 't2',
      userId: '00000000-0000-0000-0000-000000000099',
      notifuseWorkspaceSlug: 'other-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    members.push({
      tenantId: 't2',
      userId: uuid,
      role: 'member',
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'eve@example.com');
    // Dédup: owner wins, only one notifuse entry
    expect(res.tenants).toEqual([{ app: 'notifuse', role: 'owner' }]);
  });

  it('soft-deleted tenants are excluded', async () => {
    const uuid = '00000000-0000-0000-0000-000000000005';
    users.push({
      id: 'u1',
      email: 'frank@example.com',
      supabaseUserId: uuid,
    });
    tenants.push({
      id: 't1',
      userId: uuid,
      notifuseWorkspaceSlug: 'frank-ws',
      prospectionApiKey: null,
      deletedAt: new Date(),
    });
    const res = await discoverAppsByEmail(prisma, 'frank@example.com');
    expect(res.exists).toBe(true);
    expect(res.tenants).toEqual([]);
  });

  it('soft-deleted memberships are excluded', async () => {
    const uuid = '00000000-0000-0000-0000-000000000006';
    users.push({
      id: 'u1',
      email: 'gail@example.com',
      supabaseUserId: uuid,
    });
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000010',
      notifuseWorkspaceSlug: 'other-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    members.push({
      tenantId: 't1',
      userId: uuid,
      role: 'member',
      deletedAt: new Date(),
    });
    const res = await discoverAppsByEmail(prisma, 'gail@example.com');
    expect(res.tenants).toEqual([]);
  });

  it('case-insensitive email lookup', async () => {
    users.push({
      id: 'u1',
      email: 'mixedcase@example.com', // stored lowercase
      supabaseUserId: '00000000-0000-0000-0000-000000000007',
    });
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000007',
      notifuseWorkspaceSlug: 'mc-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'MIXEDCASE@example.com');
    expect(res.tenants).toEqual([{ app: 'notifuse', role: 'owner' }]);
  });

  it('does not return cms or analytics from tenant row (not denormalized yet)', async () => {
    // Garde-fou contre une régression : ne pas inventer un attachement CMS/analytics
    // tant que la table tenants n'a pas de colonnes cms_*/analytics_*.
    users.push({
      id: 'u1',
      email: 'henry@example.com',
      supabaseUserId: '00000000-0000-0000-0000-000000000008',
    });
    tenants.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000008',
      notifuseWorkspaceSlug: null,
      prospectionApiKey: null,
      deletedAt: null,
    });
    const res = await discoverAppsByEmail(prisma, 'henry@example.com');
    expect(res.tenants).toEqual([]);
  });
});
