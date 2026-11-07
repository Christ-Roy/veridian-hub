/**
 * Restes de test dans la vraie base : comptes de batterie au Hub et dans les apps, tenants sans
 * utilisateur. Le 07/11, 57 workspaces de test ont saturé Notifuse sans que rien ne les compte.
 * Mesure seule, rien n'est supprimé ici : `hub reconcile` affiche, la batterie échoue sur les siens.
 */

import type { PrismaClient } from '@prisma/client';

import type { IdentityAudit } from '@/lib/sync/types';

const PREFIXES = ['e2e-', 'e2e_', 'e2e+', 'parcours+', 'exploration+', 'brunon5robert+'];

export function isTestAccount(email: string): boolean {
  const e = email.toLowerCase();
  return PREFIXES.some((p) => e.startsWith(p)) || e.endsWith('@yopmail.com');
}

export type TestResidue = {
  hub: string[];
  apps: Record<string, string[]>;
  tenantsWithoutUser: number;
  total: number;
};

export async function measureTestResidue(
  prisma: Pick<PrismaClient, 'user'>,
  identity: IdentityAudit | undefined,
  tenantsWithoutUser: number,
): Promise<TestResidue> {
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        ...PREFIXES.map((startsWith) => ({ email: { startsWith } })),
        { email: { endsWith: '@yopmail.com' } },
      ],
    },
    select: { email: true },
  });
  const hub = rows.map((r) => r.email).filter((e): e is string => Boolean(e && isTestAccount(e)));
  const apps = Object.fromEntries(
    Object.entries(identity ?? {}).map(([app, a]) => [
      app,
      [...a.withoutHub, ...a.unlinked].filter(isTestAccount),
    ]),
  );
  const total = hub.length + Object.values(apps).reduce((n, l) => n + l.length, 0) + tenantsWithoutUser;
  return { hub, apps, tenantsWithoutUser, total };
}

/** Version sans adresse, pour les logs. */
export function residueCounts(r: TestResidue | undefined) {
  if (!r) return undefined;
  return {
    hub: r.hub.length,
    apps: Object.fromEntries(Object.entries(r.apps).map(([a, l]) => [a, l.length])),
    tenantsWithoutUser: r.tenantsWithoutUser,
    total: r.total,
  };
}
