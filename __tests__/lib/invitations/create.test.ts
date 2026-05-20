/**
 * Tests du helper de création d'invitation cross-app.
 *
 * Couvre :
 *   - création nominale (reused=false, token 64 chars, expiresAt +7j)
 *   - idempotence (pending existante réutilisée, reused=true)
 *   - expiration : invitation pending mais expirée ne bloque pas la création
 *   - acceptée : invitation acceptée ne bloque pas la création (re-invite OK)
 *   - inviter_user_id inexistant → InvitationCreateError code inviter_not_found
 *   - target_app invalide → invalid_target_app
 *   - target_role invalide → invalid_target_role
 *   - self-invitation (inviter_email == invitee_email) → self_invitation
 *   - magic link URL construction depuis NEXT_PUBLIC_SITE_URL
 *   - buildMagicLinkUrl throw si pas configuré
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  createCrossAppInvitation,
  buildMagicLinkUrl,
  generateInvitationToken,
  InvitationCreateError,
} from '@/lib/invitations/create';

type InvitationRow = {
  id: string;
  token: string;
  inviterUserId: string;
  inviterEmail: string;
  inviteeEmail: string;
  targetApp: string;
  targetWorkspaceId: string;
  targetRole: string;
  message: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  createdAt: Date;
};

function makeFakePrisma(users: { id: string; email: string }[]) {
  const invitations: InvitationRow[] = [];
  let nextId = 1;
  const fake = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
    },
    crossAppInvitation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const wExpires = where.expiresAt as { gt?: Date } | undefined;
        return (
          invitations.find(
            (i) =>
              i.inviteeEmail === where.inviteeEmail &&
              i.targetApp === where.targetApp &&
              i.targetWorkspaceId === where.targetWorkspaceId &&
              i.acceptedAt === (where.acceptedAt as unknown) &&
              (!wExpires?.gt || i.expiresAt > wExpires.gt),
          ) ?? null
        );
      },
      create: async ({ data }: { data: Omit<InvitationRow, 'id' | 'createdAt'> }) => {
        const row: InvitationRow = {
          ...data,
          message: data.message ?? null,
          acceptedAt: null,
          acceptedByUserId: null,
          id: `inv_${nextId++}`,
          createdAt: new Date(),
        };
        invitations.push(row);
        return row;
      },
    },
    __invitations: invitations, // expose for tests
  };
  return fake as unknown as PrismaClient & { __invitations: InvitationRow[] };
}

const fixedNow = new Date('2026-05-21T10:00:00Z');
const now = () => fixedNow;

describe('createCrossAppInvitation', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  const inviter = { id: 'user_owner', email: 'owner@example.com' };
  const baseInput = {
    inviterUserId: inviter.id,
    inviterEmail: inviter.email,
    inviteeEmail: 'alice@example.com',
    targetApp: 'prospection' as const,
    targetWorkspaceId: 'ws_42',
    now,
  };

  beforeEach(() => {
    prisma = makeFakePrisma([inviter]);
  });

  it('creates a new invitation with token + 7d expiry', async () => {
    const result = await createCrossAppInvitation(prisma, baseInput);
    expect(result.reused).toBe(false);
    expect(result.invitation.token).toHaveLength(64); // 32 bytes hex
    expect(result.invitation.targetRole).toBe('member');
    expect(result.invitation.expiresAt.getTime()).toBe(
      fixedNow.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(result.invitation.inviteeEmail).toBe('alice@example.com');
    expect(result.invitation.message).toBeNull();
  });

  it('uses generateToken override (deterministic in tests)', async () => {
    const result = await createCrossAppInvitation(prisma, {
      ...baseInput,
      generateToken: () => 'deterministic-token-xyz',
    });
    expect(result.invitation.token).toBe('deterministic-token-xyz');
  });

  it('reuses existing pending invitation (idempotence)', async () => {
    const first = await createCrossAppInvitation(prisma, {
      ...baseInput,
      generateToken: () => 'first-token',
    });
    expect(first.reused).toBe(false);

    const second = await createCrossAppInvitation(prisma, {
      ...baseInput,
      generateToken: () => 'second-token-should-not-be-used',
    });
    expect(second.reused).toBe(true);
    expect(second.invitation.id).toBe(first.invitation.id);
    expect(second.invitation.token).toBe('first-token'); // pas regénéré
    expect(prisma.__invitations).toHaveLength(1);
  });

  it('creates new invitation if previous is expired (not reused)', async () => {
    // Crée une invitation déjà expirée
    prisma.__invitations.push({
      id: 'inv_old',
      token: 'old-token',
      inviterUserId: inviter.id,
      inviterEmail: inviter.email,
      inviteeEmail: baseInput.inviteeEmail,
      targetApp: baseInput.targetApp,
      targetWorkspaceId: baseInput.targetWorkspaceId,
      targetRole: 'member',
      message: null,
      expiresAt: new Date(fixedNow.getTime() - 24 * 60 * 60 * 1000), // hier
      acceptedAt: null,
      acceptedByUserId: null,
      createdAt: new Date(fixedNow.getTime() - 8 * 24 * 60 * 60 * 1000),
    });
    const result = await createCrossAppInvitation(prisma, baseInput);
    expect(result.reused).toBe(false);
    expect(result.invitation.id).not.toBe('inv_old');
    expect(prisma.__invitations).toHaveLength(2);
  });

  it('creates new invitation if previous was accepted (re-invite OK)', async () => {
    prisma.__invitations.push({
      id: 'inv_accepted',
      token: 'accepted-token',
      inviterUserId: inviter.id,
      inviterEmail: inviter.email,
      inviteeEmail: baseInput.inviteeEmail,
      targetApp: baseInput.targetApp,
      targetWorkspaceId: baseInput.targetWorkspaceId,
      targetRole: 'member',
      message: null,
      expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000), // futur
      acceptedAt: new Date(fixedNow.getTime() - 60_000), // accepté il y a 1min
      acceptedByUserId: 'user_alice',
      createdAt: new Date(fixedNow.getTime() - 7 * 24 * 60 * 60 * 1000),
    });
    const result = await createCrossAppInvitation(prisma, baseInput);
    expect(result.reused).toBe(false);
    expect(prisma.__invitations).toHaveLength(2);
  });

  it('throws if inviter user does not exist', async () => {
    await expect(
      createCrossAppInvitation(prisma, {
        ...baseInput,
        inviterUserId: 'user_unknown',
      }),
    ).rejects.toMatchObject({
      name: 'InvitationCreateError',
      code: 'inviter_not_found',
    });
  });

  it('throws on invalid target_app', async () => {
    await expect(
      createCrossAppInvitation(prisma, {
        ...baseInput,
        // @ts-expect-error testing runtime guard
        targetApp: 'evil-app',
      }),
    ).rejects.toMatchObject({
      name: 'InvitationCreateError',
      code: 'invalid_target_app',
    });
  });

  it('throws on invalid target_role', async () => {
    await expect(
      createCrossAppInvitation(prisma, {
        ...baseInput,
        // @ts-expect-error testing runtime guard
        targetRole: 'superuser',
      }),
    ).rejects.toMatchObject({
      name: 'InvitationCreateError',
      code: 'invalid_target_role',
    });
  });

  it('throws on self-invitation (case-insensitive)', async () => {
    await expect(
      createCrossAppInvitation(prisma, {
        ...baseInput,
        inviteeEmail: 'OWNER@example.com', // même que inviter (case diff)
      }),
    ).rejects.toMatchObject({
      name: 'InvitationCreateError',
      code: 'self_invitation',
    });
  });

  it('stores message when provided', async () => {
    const result = await createCrossAppInvitation(prisma, {
      ...baseInput,
      message: 'Bienvenue dans le workspace Acme',
    });
    expect(result.invitation.message).toBe('Bienvenue dans le workspace Acme');
  });

  it('uses provided targetRole', async () => {
    const result = await createCrossAppInvitation(prisma, {
      ...baseInput,
      targetRole: 'admin',
    });
    expect(result.invitation.targetRole).toBe('admin');
  });

  it('respects custom expiryDays', async () => {
    const result = await createCrossAppInvitation(prisma, {
      ...baseInput,
      expiryDays: 1,
    });
    expect(result.invitation.expiresAt.getTime()).toBe(
      fixedNow.getTime() + 24 * 60 * 60 * 1000,
    );
  });
});

describe('generateInvitationToken', () => {
  it('produces 64 chars hex string', () => {
    const t = generateInvitationToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens across calls (collision improbable)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generateInvitationToken());
    expect(set.size).toBe(200);
  });
});

describe('buildMagicLinkUrl', () => {
  it('builds URL from explicit base', () => {
    expect(buildMagicLinkUrl('abc', 'https://app.veridian.site')).toBe(
      'https://app.veridian.site/invite/abc',
    );
  });

  it('strips trailing slash on base', () => {
    expect(buildMagicLinkUrl('abc', 'https://app.veridian.site/')).toBe(
      'https://app.veridian.site/invite/abc',
    );
  });

  it('throws if no base provided and NEXT_PUBLIC_SITE_URL absent', () => {
    const old = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      expect(() => buildMagicLinkUrl('abc')).toThrow(
        /NEXT_PUBLIC_SITE_URL not configured/,
      );
    } finally {
      if (old !== undefined) process.env.NEXT_PUBLIC_SITE_URL = old;
    }
  });

  it('reads NEXT_PUBLIC_SITE_URL when no base passed', () => {
    const old = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
    try {
      expect(buildMagicLinkUrl('xyz')).toBe(
        'https://app.veridian.site/invite/xyz',
      );
    } finally {
      if (old !== undefined) process.env.NEXT_PUBLIC_SITE_URL = old;
      else delete process.env.NEXT_PUBLIC_SITE_URL;
    }
  });
});

describe('InvitationCreateError', () => {
  it('has name and code accessible', () => {
    const e = new InvitationCreateError('test', 'self_invitation');
    expect(e.name).toBe('InvitationCreateError');
    expect(e.code).toBe('self_invitation');
    expect(e.message).toBe('test');
  });
});
