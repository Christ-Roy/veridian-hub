/**
 * Restes de test dans la vraie base : comptes de batterie au Hub et dans les apps, tenants sans
 * utilisateur. Le 07/11, 57 workspaces de test ont saturé Notifuse sans que rien ne les compte.
 * Mesure seule, rien n'est supprimé ici : `hub reconcile` affiche, la batterie échoue sur les siens.
 */

import type { PrismaClient } from '@prisma/client';

import type { IdentityAudit } from '@/lib/sync/types';

const PREFIXES = ['e2e-', 'e2e_', 'e2e+', 'parcours+', 'exploration+', 'brunon5robert+'];

const WORKSPACE_PREFIXES = ['e2e', 'tst'];

export function isTestAccount(email: string): boolean {
  const e = email.toLowerCase();
  return PREFIXES.some((p) => e.startsWith(p)) || e.endsWith('@yopmail.com');
}

/**
 * Comptes de test PERMANENTS, par hub_user_id : ils servent, ce ne sont pas des restes. Une alarme rouge en permanence ne
 * dit plus rien (reconcile rouge du 21 au 24/11 pour ce seul compte).
 * - 9608d959… : « Préprod CRM » de Robert (11/11), espace d'essai de Mon IA (groupe atelier-8fa7e09d du job hub).
 */
const PERMANENTS = new Set(['9608d959-6ebb-4ec6-ad10-6d9bbe66e4b0']);

export type TestResidue = {
  hub: string[];
  apps: Record<string, string[]>;
  /** Workspaces de test Notifuse : chacun garde une base, c'est eux qui ont saturé. `null` = non lu. */
  notifuseWorkspaces: string[] | null;
  tenantsWithoutUser: number;
  total: number;
};

export async function measureTestResidue(
  prisma: Pick<PrismaClient, 'user'>,
  identity: IdentityAudit | undefined,
  tenantsWithoutUser: number,
  listNotifuseWorkspaces?: (prefix: string) => Promise<string[]>,
): Promise<TestResidue> {
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        ...PREFIXES.map((startsWith) => ({ email: { startsWith } })),
        { email: { endsWith: '@yopmail.com' } },
      ],
    },
    select: { email: true, supabaseUserId: true },
  });
  const permanents = rows.filter((r) => r.supabaseUserId && PERMANENTS.has(r.supabaseUserId));
  const adresses = new Set(permanents.map((r) => r.email?.toLowerCase()));
  const hub = rows.filter((r) => !permanents.includes(r)).map((r) => r.email).filter((e): e is string => Boolean(e && isTestAccount(e)));
  const apps = Object.fromEntries(
    Object.entries(identity ?? {}).map(([app, a]) => [
      app,
      [...a.withoutHub, ...a.unlinked, ...(a.awaitingProof ?? [])].filter((e) => isTestAccount(e) && !adresses.has(e.toLowerCase())),
    ]),
  );
  const notifuseWorkspaces = listNotifuseWorkspaces
    ? await Promise.all(WORKSPACE_PREFIXES.map(listNotifuseWorkspaces))
        .then((l) => l.flat())
        .catch(() => null)
    : null;
  const total =
    hub.length +
    Object.values(apps).reduce((n, l) => n + l.length, 0) +
    (notifuseWorkspaces?.length ?? 0) +
    tenantsWithoutUser;
  return { hub, apps, notifuseWorkspaces, tenantsWithoutUser, total };
}

/** Version sans adresse, pour les logs. */
export function residueCounts(r: TestResidue | undefined) {
  if (!r) return undefined;
  return {
    hub: r.hub.length,
    apps: Object.fromEntries(Object.entries(r.apps).map(([a, l]) => [a, l.length])),
    notifuseWorkspaces: r.notifuseWorkspaces?.length ?? null,
    tenantsWithoutUser: r.tenantsWithoutUser,
    total: r.total,
  };
}
