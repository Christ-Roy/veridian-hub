import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';

import {
  activateOnboarding,
  createOnboardingInvitation,
  getOnboardingInviteByToken,
  getUserOnboardingRecord,
  saveOnboardingQualification,
} from '@/lib/onboarding/service';
import {
  hashOnboardingToken,
  onboardingIdentifier,
} from '@/lib/onboarding/tokens';

const sendMailMock = vi.fn(async () => undefined);
const provisionWorkspaceMock = vi.fn(async () => ({
  workspaceId: 'ws_1',
  workspaceName: 'Atelier Robert',
  created: false,
}));
const provisionNotifuseMock = vi.fn(async () => ({ success: true, workspaceId: 'nf_1' }));
const provisionProspectionMock = vi.fn(async () => ({ success: true, tenantId: 'pr_1' }));

vi.mock('@/lib/email/send', () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));

vi.mock('@/utils/helpers', () => ({
  getURL: () => 'https://app.veridian.site',
}));

vi.mock('@/lib/workspace/provision', () => ({
  provisionDefaultWorkspace: (...args: unknown[]) => provisionWorkspaceMock(...args),
}));

vi.mock('@/utils/tenants/provision', () => ({
  provisionNotifuseTenant: (...args: unknown[]) => provisionNotifuseMock(...args),
  provisionProspectionTenant: (...args: unknown[]) => provisionProspectionMock(...args),
}));

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  supabaseUserId: string | null;
  accounts: Array<{ id: string; provider: string; access_token?: string | null }>;
  onboarding?: { userId: string; metadata: unknown; activatedAt: Date | null; completedAt?: Date | null } | null;
};

function makeFakePrisma() {
  const users = new Map<string, UserRow>();
  const tokens = new Map<string, { identifier: string; token: string; expires: Date }>();
  const onboarding = new Map<string, any>();
  const accountCreates: any[] = [];
  const accountUpdates: any[] = [];

  const fake = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        const user =
          (where.email ? Array.from(users.values()).find((u) => u.email === where.email) : null) ??
          (where.id ? users.get(where.id) : null) ??
          null;
        if (!user) return null;
        return {
          ...user,
          onboarding: onboarding.get(user.id) ?? user.onboarding ?? null,
        };
      }),
    },
    verificationToken: {
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (const [key, value] of Array.from(tokens)) {
          if (!where.identifier || value.identifier === where.identifier) {
            tokens.delete(key);
            count++;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        tokens.set(data.token, data);
        return data;
      }),
      findUnique: vi.fn(async ({ where }: any) => tokens.get(where.token) ?? null),
      delete: vi.fn(async ({ where }: any) => {
        const row = tokens.get(where.token);
        tokens.delete(where.token);
        return row;
      }),
    },
    userOnboarding: {
      findUnique: vi.fn(async ({ where }: any) => onboarding.get(where.userId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const current = onboarding.get(where.userId);
        const next = current
          ? { ...current, ...update, userId: where.userId }
          : { ...create, userId: create.userId ?? where.userId };
        onboarding.set(where.userId, next);
        return next;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const current = onboarding.get(where.userId) ?? { userId: where.userId };
        const next = { ...current, ...data };
        onboarding.set(where.userId, next);
        return next;
      }),
    },
    account: {
      create: vi.fn(async ({ data }: any) => {
        accountCreates.push(data);
        const user = users.get(data.userId)!;
        user.accounts.push({ id: `acc_${accountCreates.length}`, ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        accountUpdates.push({ where, data });
        for (const user of users.values()) {
          const account = user.accounts.find((a) => a.id === where.id);
          if (account) Object.assign(account, data);
        }
        return data;
      }),
    },
    workspaceMember: {
      findFirst: vi.fn(async () => ({
        workspace: { name: 'Atelier Robert' },
      })),
    },
    $transaction: vi.fn(async (arg: any) => {
      if (typeof arg === 'function') return arg(fake);
      return Promise.all(arg);
    }),
    __users: users,
    __tokens: tokens,
    __onboarding: onboarding,
    __accountCreates: accountCreates,
    __accountUpdates: accountUpdates,
  };
  return fake as unknown as PrismaClient & typeof fake;
}

describe('onboarding service', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makeFakePrisma();
    prisma.__users.set('u_1', {
      id: 'u_1',
      email: 'client@example.com',
      name: 'Client Test',
      supabaseUserId: '11111111-1111-4111-8111-111111111111',
      accounts: [],
    });
  });

  it('génère un lien durable en stockant uniquement le hash du token brut', async () => {
    const result = await createOnboardingInvitation(prisma, {
      email: 'CLIENT@example.com',
      apps: ['notifuse', 'prospection'],
      actor: 'admin:robert@veridian.site',
      sendEmail: true,
    });

    const rawToken = result.inviteUrl.split('/onboard/')[1];
    expect(rawToken).toBeTruthy();
    expect(prisma.__tokens.size).toBe(1);
    const stored = Array.from(prisma.__tokens.values())[0];
    expect(stored.identifier).toBe(onboardingIdentifier('u_1'));
    expect(stored.token).toBe(hashOnboardingToken(rawToken));
    expect(stored.token).not.toBe(rawToken);
    expect(stored.expires.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(prisma.__onboarding.get('u_1').metadata.apps).toEqual(['notifuse', 'prospection']);
  });

  it('consomme le token une seule fois et crée le compte credentials bcrypt', async () => {
    const invite = await createOnboardingInvitation(prisma, {
      email: 'client@example.com',
      apps: ['notifuse', 'prospection'],
      actor: 'admin:robert@veridian.site',
      sendEmail: false,
    });
    const rawToken = invite.inviteUrl.split('/onboard/')[1];

    const result = await activateOnboarding(prisma, {
      token: rawToken,
      password: 'Motdepasse10',
    });

    expect(result.email).toBe('client@example.com');
    expect(prisma.__tokens.size).toBe(0);
    expect(prisma.__accountCreates).toHaveLength(1);
    const created = prisma.__accountCreates[0];
    expect(created.provider).toBe('credentials');
    expect(created.access_token).not.toBe('Motdepasse10');
    await expect(bcrypt.compare('Motdepasse10', created.access_token)).resolves.toBe(true);
    expect(prisma.__onboarding.get('u_1').activatedAt).toBeInstanceOf(Date);
    expect(provisionNotifuseMock).toHaveBeenCalledTimes(1);
    expect(provisionProspectionMock).toHaveBeenCalledTimes(1);

    await expect(
      activateOnboarding(prisma, { token: rawToken, password: 'Motdepasse10' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('ne mute pas le mot de passe si le token a été claimé par une requête concurrente', async () => {
    const invite = await createOnboardingInvitation(prisma, {
      email: 'client@example.com',
      apps: ['notifuse'],
      actor: 'admin:robert@veridian.site',
      sendEmail: false,
    });
    const rawToken = invite.inviteUrl.split('/onboard/')[1];

    // Simule la course : findUnique voit encore le token, mais le deleteMany
    // atomique dans la transaction ne claim rien car une autre requête l'a
    // supprimé juste avant.
    vi.mocked(prisma.verificationToken.deleteMany).mockResolvedValueOnce({ count: 0 });

    await expect(
      activateOnboarding(prisma, { token: rawToken, password: 'Motdepasse10' }),
    ).rejects.toMatchObject({ code: 'activated' });

    expect(prisma.__accountCreates).toHaveLength(0);
    expect(prisma.__accountUpdates).toHaveLength(0);
    expect(provisionNotifuseMock).not.toHaveBeenCalled();
  });

  it('sauvegarde la qualification dans user_onboarding.metadata et marque completedAt', async () => {
    const record = await saveOnboardingQualification(prisma, {
      userId: 'u_1',
      qualification: { business: 'agence', goals: ['prospection'] },
      etapeCourante: 'recapitulatif',
      completed: true,
    });

    const row = prisma.__onboarding.get('u_1');
    expect(row.metadata.qualification).toEqual({
      business: 'agence',
      goals: ['prospection'],
    });
    expect(row.metadata.etapeCourante).toBe('recapitulatif');
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(record.userId).toBe('u_1');
    expect(record.completedAt).toBe(row.completedAt.toISOString());
    expect(record.metadata?.qualification).toEqual(row.metadata.qualification);
  });

  it('résout une invitation publique depuis le token brut sans exposer le hash', async () => {
    const invite = await createOnboardingInvitation(prisma, {
      email: 'client@example.com',
      apps: ['hub', 'analytics', 'unknown'],
      actor: 'admin:robert@veridian.site',
      invitedBy: 'Robert',
      sendEmail: false,
    });
    const rawToken = invite.inviteUrl.split('/onboard/')[1];

    const lookup = await getOnboardingInviteByToken(prisma, rawToken);

    expect(lookup).toMatchObject({
      ok: true,
      userId: 'u_1',
      invite: {
        email: 'client@example.com',
        workspaceName: 'Atelier Robert',
        invitedBy: 'Robert',
      },
    });
    if (lookup.ok) {
      expect(lookup.invite.apps.map((app) => app.id)).toEqual(['hub', 'analytics']);
      expect(JSON.stringify(lookup.invite)).not.toContain(hashOnboardingToken(rawToken));
    }
  });

  it('supprime et signale expired quand le token onboarding a dépassé sa date', async () => {
    const token = 'expired-token';
    const tokenHash = hashOnboardingToken(token);
    prisma.__tokens.set(tokenHash, {
      identifier: onboardingIdentifier('u_1'),
      token: tokenHash,
      expires: new Date(Date.now() - 1000),
    });

    await expect(getOnboardingInviteByToken(prisma, token)).resolves.toEqual({
      ok: false,
      code: 'expired',
    });
    expect(prisma.__tokens.size).toBe(0);
  });

  it('renvoie activated si le user a déjà un compte credentials', async () => {
    const token = 'already-activated-token';
    const tokenHash = hashOnboardingToken(token);
    prisma.__tokens.set(tokenHash, {
      identifier: onboardingIdentifier('u_1'),
      token: tokenHash,
      expires: new Date(Date.now() + 60_000),
    });
    prisma.__users.get('u_1')!.accounts.push({
      id: 'acc_credentials',
      provider: 'credentials',
    });

    await expect(getOnboardingInviteByToken(prisma, token)).resolves.toEqual({
      ok: false,
      code: 'activated',
    });
  });

  it('met à jour un compte credentials existant au lieu d’en créer un second', async () => {
    prisma.__users.get('u_1')!.accounts.push({
      id: 'acc_existing',
      provider: 'credentials',
      access_token: 'old-hash',
    });
    const invite = await createOnboardingInvitation(prisma, {
      email: 'client@example.com',
      apps: ['hub'],
      actor: 'admin:robert@veridian.site',
      sendEmail: false,
    });

    await activateOnboarding(prisma, {
      token: invite.inviteUrl.split('/onboard/')[1],
      password: 'NouveauMotdepasse10',
    });

    expect(prisma.__accountCreates).toHaveLength(0);
    expect(prisma.__accountUpdates).toHaveLength(1);
    expect(prisma.__accountUpdates[0].where).toEqual({ id: 'acc_existing' });
    await expect(
      bcrypt.compare('NouveauMotdepasse10', prisma.__accountUpdates[0].data.access_token),
    ).resolves.toBe(true);
  });

  it('sérialise getUserOnboardingRecord avec dates ISO et metadata objet', async () => {
    const completedAt = new Date('2026-08-17T12:00:00.000Z');
    prisma.__onboarding.set('u_1', {
      userId: 'u_1',
      invitedAt: null,
      activatedAt: completedAt,
      firstAppStartedAt: null,
      memberInvitedAt: null,
      workspaceRenamedAt: null,
      completedAt,
      metadata: { qualification: { prospection: 'explorer' } },
    });

    await expect(getUserOnboardingRecord(prisma, 'u_1')).resolves.toEqual({
      userId: 'u_1',
      invitedAt: null,
      activatedAt: '2026-08-17T12:00:00.000Z',
      firstAppStartedAt: null,
      memberInvitedAt: null,
      workspaceRenamedAt: null,
      completedAt: '2026-08-17T12:00:00.000Z',
      metadata: { qualification: { prospection: 'explorer' } },
    });
  });
});
