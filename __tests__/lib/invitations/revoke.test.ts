/**
 * Tests du helper de révocation d'invitation cross-app.
 *
 * Couvre :
 *   - révocation nominale (expiresAt forcé à now)
 *   - invitation inconnue → not_found
 *   - inviter mismatch → forbidden
 *   - invitation déjà acceptée → already_accepted (pas révocable)
 *   - invitation déjà expirée → ok + alreadyInactive=true (no-op DB)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { revokeCrossAppInvitation } from '@/lib/invitations/revoke';

type InvRow = {
  id: string;
  inviterUserId: string;
  inviteeEmail: string;
  targetApp: string;
  targetWorkspaceId: string;
  targetRole: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
};

const fixedNow = new Date('2026-05-21T13:00:00Z');
const now = () => fixedNow;

function makeFakePrisma(seed: InvRow[]) {
  const data = [...seed];
  let updateCalled = 0;
  const fake = {
    $transaction: async (fn: (tx: any) => any) => fn(fake),
    crossAppInvitation: {
      findUnique: async ({ where }: any) =>
        data.find((i) => i.id === where.id) ?? null,
      update: async ({ where, data: patch }: any) => {
        updateCalled += 1;
        const row = data.find((i) => i.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, patch);
        return row;
      },
    },
    __data: data,
    __updateCalls: () => updateCalled,
  };
  return fake as unknown as PrismaClient & {
    __data: InvRow[];
    __updateCalls: () => number;
  };
}

function row(overrides: Partial<InvRow> = {}): InvRow {
  return {
    id: 'inv_x',
    inviterUserId: 'user_owner',
    inviteeEmail: 'alice@example.com',
    targetApp: 'prospection',
    targetWorkspaceId: 'ws_42',
    targetRole: 'member',
    expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
    acceptedAt: null,
    acceptedByUserId: null,
    ...overrides,
  };
}

describe('revokeCrossAppInvitation', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;

  it('revokes an active invitation (expiresAt set to now)', async () => {
    prisma = makeFakePrisma([row()]);
    const result = await revokeCrossAppInvitation(prisma, {
      invitationId: 'inv_x',
      expectedInviterUserId: 'user_owner',
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyInactive).toBe(false);
    expect(result.invitation.expiresAt).toEqual(fixedNow);
    expect(prisma.__updateCalls()).toBe(1);
  });

  it('returns not_found for unknown id', async () => {
    prisma = makeFakePrisma([row()]);
    const result = await revokeCrossAppInvitation(prisma, {
      invitationId: 'inv_unknown',
      expectedInviterUserId: 'user_owner',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(prisma.__updateCalls()).toBe(0);
  });

  it('returns forbidden when inviter mismatch', async () => {
    prisma = makeFakePrisma([row()]);
    const result = await revokeCrossAppInvitation(prisma, {
      invitationId: 'inv_x',
      expectedInviterUserId: 'user_attacker',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
    expect(prisma.__updateCalls()).toBe(0);
  });

  it('returns already_accepted on accepted invitation (not revocable)', async () => {
    prisma = makeFakePrisma([
      row({
        acceptedAt: new Date(fixedNow.getTime() - 60_000),
        acceptedByUserId: 'user_alice',
      }),
    ]);
    const result = await revokeCrossAppInvitation(prisma, {
      invitationId: 'inv_x',
      expectedInviterUserId: 'user_owner',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('already_accepted');
    expect(prisma.__updateCalls()).toBe(0);
  });

  it('returns ok + alreadyInactive=true if already expired (no DB write)', async () => {
    prisma = makeFakePrisma([
      row({ expiresAt: new Date(fixedNow.getTime() - 60_000) }),
    ]);
    const result = await revokeCrossAppInvitation(prisma, {
      invitationId: 'inv_x',
      expectedInviterUserId: 'user_owner',
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyInactive).toBe(true);
    expect(prisma.__updateCalls()).toBe(0);
  });

  it('forbidden check takes priority over accepted check (no info leak)', async () => {
    // L'attaquant ne doit pas pouvoir distinguer "accepted" de "forbidden"
    // pour quelqu'un d'autre — sinon on lui révèle le statut.
    prisma = makeFakePrisma([
      row({
        acceptedAt: new Date(fixedNow.getTime() - 60_000),
        acceptedByUserId: 'user_someone',
      }),
    ]);
    const result = await revokeCrossAppInvitation(prisma, {
      invitationId: 'inv_x',
      expectedInviterUserId: 'user_attacker',
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
  });
});
