import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';

import { sendMail } from '@/lib/email/send';
import { buildOnboardingInvitationEmail } from '@/lib/email/templates/onboarding-invitation';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';
import { provisionNotifuseTenant, provisionProspectionTenant } from '@/utils/tenants/provision';
import { getURL } from '@/utils/helpers';
import {
  generateOnboardingToken,
  hashOnboardingToken,
  onboardingIdentifier,
  ONBOARDING_TOKEN_TTL_MS,
  userIdFromOnboardingIdentifier,
} from './tokens';

export type OnboardingAppKey = 'hub' | 'notifuse' | 'prospection' | 'analytics' | 'cms' | 'crm';

export type PublicOnboardingInvite = {
  email: string;
  workspaceName: string;
  invitedBy: string;
  apps: Array<{ id: string; label: string; suffix: string; tagline: string }>;
  expiresAt: string;
};

export type OnboardingTokenLookup =
  | { ok: true; invite: PublicOnboardingInvite; userId: string; expiresAt: Date }
  | { ok: false; code: 'invalid' | 'expired' | 'activated' };

export type UserOnboardingRecord = {
  userId: string;
  invitedAt: string | null;
  activatedAt: string | null;
  firstAppStartedAt: string | null;
  memberInvitedAt: string | null;
  workspaceRenamedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown> | null;
};

const APP_DETAILS: Record<string, PublicOnboardingInvite['apps'][number]> = {
  hub: {
    id: 'hub',
    label: 'Hub',
    suffix: '.hub',
    tagline: 'Votre cockpit central pour les accès, la facturation et les outils.',
  },
  notifuse: {
    id: 'notifuse',
    label: 'Mail',
    suffix: '.mail',
    tagline: 'Emails transactionnels et campagnes, prêts à partir.',
  },
  prospection: {
    id: 'prospection',
    label: 'Prospection',
    suffix: '.sales',
    tagline: 'Recherche de prospects et séquences commerciales.',
  },
  analytics: {
    id: 'analytics',
    label: 'Analytics',
    suffix: '.data',
    tagline: 'Mesure et lecture claire de vos performances.',
  },
  cms: {
    id: 'cms',
    label: 'CMS',
    suffix: '.site',
    tagline: 'Contenus et pages pilotables sans développement.',
  },
  crm: {
    id: 'crm',
    label: 'CRM',
    suffix: '.crm',
    tagline: 'Suivi commercial et relation client.',
  },
};

const ONBOARDING_APP_KEYS = [
  'hub',
  'notifuse',
  'prospection',
  'analytics',
  'cms',
  'crm',
] as const satisfies readonly OnboardingAppKey[];

function isOnboardingAppKey(value: string): value is OnboardingAppKey {
  return (ONBOARDING_APP_KEYS as readonly string[]).includes(value);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeApps(apps: string[] | undefined | null): OnboardingAppKey[] {
  const raw = apps?.length ? apps : ['hub'];
  const valid = raw
    .map((app) => app.trim().toLowerCase())
    .filter(isOnboardingAppKey);
  const selected: OnboardingAppKey[] = valid.length ? valid : ['hub'];
  return Array.from(new Set<OnboardingAppKey>(selected));
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getMetadataApps(metadata: unknown): string[] {
  const apps = metadataObject(metadata).apps;
  if (!Array.isArray(apps)) return ['hub'];
  return apps.filter((app): app is string => typeof app === 'string');
}

function serializeOnboardingRecord(row: {
  userId: string;
  invitedAt: Date | null;
  activatedAt: Date | null;
  firstAppStartedAt: Date | null;
  memberInvitedAt: Date | null;
  workspaceRenamedAt: Date | null;
  completedAt: Date | null;
  metadata: unknown;
}): UserOnboardingRecord {
  return {
    userId: row.userId,
    invitedAt: row.invitedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    firstAppStartedAt: row.firstAppStartedAt?.toISOString() ?? null,
    memberInvitedAt: row.memberInvitedAt?.toISOString() ?? null,
    workspaceRenamedAt: row.workspaceRenamedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    metadata: row.metadata ? metadataObject(row.metadata) : null,
  };
}

export async function createOnboardingInvitation(
  prisma: PrismaClient,
  input: {
    email: string;
    apps?: string[];
    actor: string;
    invitedBy?: string;
    sendEmail?: boolean;
  }
): Promise<{
  userId: string;
  email: string;
  inviteUrl: string;
  expiresAt: Date;
  apps: OnboardingAppKey[];
  emailSent: boolean;
}> {
  const email = normalizeEmail(input.email);
  const apps = normalizeApps(input.apps);
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, supabaseUserId: true },
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { code: 'user_not_found' });
  }

  const workspace = await provisionDefaultWorkspace(
    { userId: user.id, email: user.email, name: user.name },
    { prisma, actor: input.actor },
  );

  const token = generateOnboardingToken();
  const tokenHash = hashOnboardingToken(token);
  const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_MS);
  const identifier = onboardingIdentifier(user.id);
  const inviteUrl = `${getURL()}/onboard/${encodeURIComponent(token)}`;
  const invitedBy = input.invitedBy ?? input.actor.replace(/^admin:/, '');

  const existing = await prisma.userOnboarding.findUnique({
    where: { userId: user.id },
    select: { metadata: true },
  });
  const previousMetadata = metadataObject(existing?.metadata);

  await prisma.$transaction([
    prisma.verificationToken.deleteMany({ where: { identifier } }),
    prisma.verificationToken.create({
      data: { identifier, token: tokenHash, expires: expiresAt },
    }),
    prisma.userOnboarding.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        invitedAt: new Date(),
        metadata: {
          ...previousMetadata,
          apps,
          invitedBy,
          workspaceName: workspace.workspaceName,
          invitationExpiresAt: expiresAt.toISOString(),
          invitationRenewedAt: new Date().toISOString(),
          invitationActor: input.actor,
        } as never,
      },
      update: {
        invitedAt: new Date(),
        metadata: {
          ...previousMetadata,
          apps,
          invitedBy,
          workspaceName: workspace.workspaceName,
          invitationExpiresAt: expiresAt.toISOString(),
          invitationRenewedAt: new Date().toISOString(),
          invitationActor: input.actor,
        } as never,
      },
    }),
  ]);

  let emailSent = false;
  if (input.sendEmail !== false) {
    const emailPayload = buildOnboardingInvitationEmail({
      email: user.email,
      invitedBy,
      workspaceName: workspace.workspaceName,
      apps,
      inviteUrl,
      expiresAt,
    });
    await sendMail({ to: user.email, ...emailPayload });
    emailSent = true;
  }

  return { userId: user.id, email: user.email, inviteUrl, expiresAt, apps, emailSent };
}

export async function getOnboardingInviteByToken(
  prisma: PrismaClient,
  token: string,
): Promise<OnboardingTokenLookup> {
  const tokenHash = hashOnboardingToken(token);
  const record = await prisma.verificationToken.findUnique({
    where: { token: tokenHash },
  });
  if (!record) return { ok: false, code: 'invalid' };

  const userId = userIdFromOnboardingIdentifier(record.identifier);
  if (!userId) return { ok: false, code: 'invalid' };

  if (record.expires < new Date()) {
    await prisma.verificationToken.delete({ where: { token: tokenHash } }).catch(() => {});
    return { ok: false, code: 'expired' };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      onboarding: true,
      accounts: { select: { provider: true } },
    },
  });
  if (!user) return { ok: false, code: 'invalid' };
  if (user.onboarding?.activatedAt || user.accounts.some((a) => a.provider === 'credentials')) {
    return { ok: false, code: 'activated' };
  }

  const workspaceMember = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { deletedAt: null } },
    include: { workspace: { select: { name: true } } },
  });

  const metadata = metadataObject(user.onboarding?.metadata);
  const apps = getMetadataApps(metadata);
  const workspaceName =
    typeof metadata.workspaceName === 'string'
      ? metadata.workspaceName
      : workspaceMember?.workspace.name ?? `${user.email.split('@')[0]} workspace`;
  const invitedBy =
    typeof metadata.invitedBy === 'string' ? metadata.invitedBy : 'Veridian';

  return {
    ok: true,
    userId,
    expiresAt: record.expires,
    invite: {
      email: user.email,
      workspaceName,
      invitedBy,
      expiresAt: record.expires.toISOString(),
      apps: normalizeApps(apps).map((app) => APP_DETAILS[app]),
    },
  };
}

export async function activateOnboarding(
  prisma: PrismaClient,
  input: { token: string; password: string },
): Promise<{
  email: string;
  userId: string;
  apps: string[];
  provisioning: Record<string, { success: boolean; error?: string }>;
}> {
  const tokenHash = hashOnboardingToken(input.token);
  const record = await prisma.verificationToken.findUnique({
    where: { token: tokenHash },
  });
  if (!record) {
    throw Object.assign(new Error('invalid'), { code: 'invalid' });
  }
  const userId = userIdFromOnboardingIdentifier(record.identifier);
  if (!userId) {
    throw Object.assign(new Error('invalid'), { code: 'invalid' });
  }
  if (record.expires < new Date()) {
    await prisma.verificationToken.delete({ where: { token: tokenHash } }).catch(() => {});
    throw Object.assign(new Error('expired'), { code: 'expired' });
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  const now = new Date();

  const activation = await prisma.$transaction(async (tx) => {
    const claimed = await tx.verificationToken.deleteMany({
      where: {
        identifier: record.identifier,
        token: tokenHash,
        expires: { gt: now },
      },
    });
    if (claimed.count !== 1) {
      throw Object.assign(new Error('invalid'), { code: 'invalid' });
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { accounts: true, onboarding: true },
    });
    if (!user) {
      throw Object.assign(new Error('User not found'), { code: 'user_not_found' });
    }

    const activatedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      supabaseUserId: user.supabaseUserId,
    };
    const metadata = metadataObject(user.onboarding?.metadata);
    const apps = normalizeApps(getMetadataApps(metadata));
    const credentials = user.accounts.find((a) => a.provider === 'credentials');

    if (credentials) {
      await tx.account.update({
        where: { id: credentials.id },
        data: { access_token: passwordHash, providerAccountId: user.email },
      });
    } else {
      await tx.account.create({
        data: {
          userId: user.id,
          type: 'credentials',
          provider: 'credentials',
          providerAccountId: user.email,
          access_token: passwordHash,
        },
      });
    }

    await tx.userOnboarding.upsert({
      where: { userId: userId },
      create: {
        userId,
        invitedAt: now,
        activatedAt: now,
        metadata: {
          ...metadata,
          apps,
          activatedVia: 'onboarding-token',
          activatedAt: now.toISOString(),
        } as never,
      },
      update: {
        activatedAt: now,
        metadata: {
          ...metadata,
          apps,
          activatedVia: 'onboarding-token',
          activatedAt: now.toISOString(),
        } as never,
      },
    });

    return { user: activatedUser, apps, metadata };
  });

  await provisionDefaultWorkspace(
    {
      userId: activation.user.id,
      email: activation.user.email,
      name: activation.user.name,
    },
    { prisma, actor: 'system:onboarding-activation' },
  );

  const provisioning: Record<string, { success: boolean; error?: string }> = {};
  if (activation.user.supabaseUserId) {
    if (activation.apps.includes('notifuse')) {
      const result = await provisionNotifuseTenant(
        activation.user.email,
        activation.user.supabaseUserId,
      );
      provisioning.notifuse = { success: result.success, error: result.error };
    }
    if (activation.apps.includes('prospection')) {
      const result = await provisionProspectionTenant(
        activation.user.email,
        activation.user.supabaseUserId,
      );
      provisioning.prospection = { success: result.success, error: result.error };
    }
  }

  await prisma.userOnboarding.update({
    where: { userId: activation.user.id },
    data: {
      firstAppStartedAt: Object.values(provisioning).some((p) => p.success) ? new Date() : undefined,
      metadata: {
        ...activation.metadata,
        apps: activation.apps,
        activatedVia: 'onboarding-token',
        activatedAt: now.toISOString(),
        provisioning,
      } as never,
    },
  });

  return {
    email: activation.user.email,
    userId: activation.user.id,
    apps: activation.apps,
    provisioning,
  };
}

export async function saveOnboardingQualification(
  prisma: PrismaClient,
  input: {
    userId: string;
    qualification: Record<string, unknown>;
    etapeCourante?: string;
    completed?: boolean;
  },
): Promise<UserOnboardingRecord> {
  const existing = await prisma.userOnboarding.findUnique({
    where: { userId: input.userId },
    select: { metadata: true, completedAt: true },
  });
  const metadata = metadataObject(existing?.metadata);
  const now = new Date();

  const row = await prisma.userOnboarding.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      completedAt: input.completed ? now : null,
      metadata: {
        ...metadata,
        qualification: input.qualification,
        ...(input.etapeCourante ? { etapeCourante: input.etapeCourante } : {}),
        qualificationUpdatedAt: now.toISOString(),
      } as never,
    },
    update: {
      completedAt: input.completed ? existing?.completedAt ?? now : undefined,
      metadata: {
        ...metadata,
        qualification: input.qualification,
        ...(input.etapeCourante ? { etapeCourante: input.etapeCourante } : {}),
        qualificationUpdatedAt: now.toISOString(),
      } as never,
    },
  });
  return serializeOnboardingRecord(row);
}

export async function getUserOnboardingRecord(
  prisma: PrismaClient,
  userId: string,
): Promise<UserOnboardingRecord | null> {
  const row = await prisma.userOnboarding.findUnique({ where: { userId } });
  return row ? serializeOnboardingRecord(row) : null;
}
