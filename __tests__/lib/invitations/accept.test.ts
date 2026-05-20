/**
 * Tests du helper d'acceptation d'invitation cross-app.
 *
 * Couvre :
 *   - acceptation nominale (acceptedAt/acceptedByUserId set, downstreamCall pending)
 *   - format token invalide → invalid_token_format (sans hit DB)
 *   - token inconnu → not_found
 *   - invitation expirée → expired
 *   - invitation déjà acceptée → already_accepted (avec acceptedByUserId)
 *   - email mismatch refusé par défaut → email_mismatch
 *   - email mismatch autorisé via allowEmailMismatch=true → ok + emailMismatch:true
 *   - email compare case-insensitive
 *   - buildPostAcceptRedirectUrl pour chaque app + fallback
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  acceptCrossAppInvitation,
  buildPostAcceptRedirectUrl,
} from '@/lib/invitations/accept';

type InvRow = {
  id: string;
  token: string;
  inviteeEmail: string;
  targetApp: string;
  targetWorkspaceId: string;
  targetRole: string;
  message: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
};

function makeFakePrisma(seed: InvRow[]) {
  const data = [...seed];
  const fake = {
    $transaction: async (fn: (tx: any) => any) => fn(fake),
    crossAppInvitation: {
      findUnique: async ({ where }: any) =>
        data.find((i) => i.token === where.token) ?? null,
      update: async ({ where, data: patch }: any) => {
        const row = data.find((i) => i.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, patch);
        return row;
      },
    },
    __data: data,
  };
  return fake as unknown as PrismaClient & { __data: InvRow[] };
}

const validToken = 'a'.repeat(64);
const expiredToken = 'b'.repeat(64);
const acceptedToken = 'c'.repeat(64);

const fixedNow = new Date('2026-05-21T12:00:00Z');
const now = () => fixedNow;

function baseSeed(): InvRow[] {
  return [
    {
      id: 'inv_active',
      token: validToken,
      inviteeEmail: 'alice@example.com',
      targetApp: 'prospection',
      targetWorkspaceId: 'ws_42',
      targetRole: 'member',
      message: null,
      expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
      acceptedAt: null,
      acceptedByUserId: null,
    },
    {
      id: 'inv_expired',
      token: expiredToken,
      inviteeEmail: 'bob@example.com',
      targetApp: 'notifuse',
      targetWorkspaceId: 'ws_99',
      targetRole: 'member',
      message: null,
      expiresAt: new Date(fixedNow.getTime() - 60_000),
      acceptedAt: null,
      acceptedByUserId: null,
    },
    {
      id: 'inv_accepted',
      token: acceptedToken,
      inviteeEmail: 'charlie@example.com',
      targetApp: 'cms',
      targetWorkspaceId: 'ws_77',
      targetRole: 'admin',
      message: null,
      expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
      acceptedAt: new Date(fixedNow.getTime() - 60_000),
      acceptedByUserId: 'user_other',
    },
  ];
}

describe('acceptCrossAppInvitation', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  beforeEach(() => {
    prisma = makeFakePrisma(baseSeed());
  });

  it('marks invitation accepted on happy path', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: validToken,
      acceptingUserId: 'user_alice',
      acceptingUserEmail: 'alice@example.com',
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invitation.acceptedAt).toEqual(fixedNow);
    expect(result.invitation.acceptedByUserId).toBe('user_alice');
    expect(result.emailMismatch).toBe(false);
    expect(result.downstreamCall).toBe('pending');

    // DB row mutated
    const row = prisma.__data.find((r) => r.id === 'inv_active')!;
    expect(row.acceptedAt).toEqual(fixedNow);
    expect(row.acceptedByUserId).toBe('user_alice');
  });

  it('returns invalid_token_format for malformed token', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: 'not-hex',
      acceptingUserId: 'user_x',
      acceptingUserEmail: 'x@x.com',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_token_format');
  });

  it('returns not_found for unknown token', async () => {
    const unknown = 'e'.repeat(64);
    const result = await acceptCrossAppInvitation(prisma, {
      token: unknown,
      acceptingUserId: 'user_x',
      acceptingUserEmail: 'x@x.com',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('returns expired for past-due invitation', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: expiredToken,
      acceptingUserId: 'user_bob',
      acceptingUserEmail: 'bob@example.com',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('expired');
  });

  it('returns already_accepted with acceptedByUserId', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: acceptedToken,
      acceptingUserId: 'user_charlie',
      acceptingUserEmail: 'charlie@example.com',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('already_accepted');
      expect(result.acceptedByUserId).toBe('user_other');
    }
  });

  it('returns email_mismatch when email differs and allowEmailMismatch false', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: validToken,
      acceptingUserId: 'user_zoe',
      acceptingUserEmail: 'zoe@example.com',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('email_mismatch');
  });

  it('accepts with email mismatch when allowEmailMismatch=true', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: validToken,
      acceptingUserId: 'user_zoe',
      acceptingUserEmail: 'zoe@example.com',
      allowEmailMismatch: true,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emailMismatch).toBe(true);
    expect(result.invitation.acceptedByUserId).toBe('user_zoe');
  });

  it('compares emails case-insensitively', async () => {
    const result = await acceptCrossAppInvitation(prisma, {
      token: validToken,
      acceptingUserId: 'user_alice',
      acceptingUserEmail: 'ALICE@example.com',
      now,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.emailMismatch).toBe(false);
  });

  it('does not mutate already-accepted row when re-attempted', async () => {
    const before = prisma.__data.find((r) => r.id === 'inv_accepted')!;
    const beforeAcceptedAt = before.acceptedAt;
    const beforeBy = before.acceptedByUserId;

    await acceptCrossAppInvitation(prisma, {
      token: acceptedToken,
      acceptingUserId: 'user_attacker',
      acceptingUserEmail: 'charlie@example.com',
      now,
    });

    const after = prisma.__data.find((r) => r.id === 'inv_accepted')!;
    expect(after.acceptedAt).toEqual(beforeAcceptedAt);
    expect(after.acceptedByUserId).toBe(beforeBy);
  });
});

describe('buildPostAcceptRedirectUrl', () => {
  it('uses NEXT_PUBLIC_<APP>_URL when configured', () => {
    const env = {
      NEXT_PUBLIC_PROSPECTION_URL: 'https://prospection.app.veridian.site',
      NEXT_PUBLIC_NOTIFUSE_URL: 'https://notifuse.app.veridian.site',
      NEXT_PUBLIC_ANALYTICS_URL: 'https://analytics.app.veridian.site',
      NEXT_PUBLIC_CMS_URL: 'https://cms.veridian.site',
    } as NodeJS.ProcessEnv;
    expect(buildPostAcceptRedirectUrl('prospection', env)).toBe(
      'https://prospection.app.veridian.site',
    );
    expect(buildPostAcceptRedirectUrl('cms', env)).toBe(
      'https://cms.veridian.site',
    );
  });

  it('strips trailing slash', () => {
    expect(
      buildPostAcceptRedirectUrl('analytics', {
        NEXT_PUBLIC_ANALYTICS_URL: 'https://analytics.app.veridian.site/',
      } as NodeJS.ProcessEnv),
    ).toBe('https://analytics.app.veridian.site');
  });

  it('falls back to convention <app>.app.veridian.site when env absent', () => {
    expect(buildPostAcceptRedirectUrl('notifuse', {} as NodeJS.ProcessEnv)).toBe(
      'https://notifuse.app.veridian.site',
    );
  });
});
