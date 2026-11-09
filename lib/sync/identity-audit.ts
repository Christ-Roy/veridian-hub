/**
 * Audit d'identité (CONTRAT-HUB §3.8) : le Hub est la seule source de vérité des
 * utilisateurs, chaque app n'en garde qu'une copie. On compare donc les comptes
 * humains de chaque app à ceux du Hub.
 *
 *     GET <app>/api/hub/users   (HMAC §6.1, corps vide)
 *     { users: [{ hub_user_id, email, name }] }   humains seulement, pas de clé machine
 *
 * Trois états : une app qui n'expose pas encore l'endpoint est `endpoint_missing`,
 * affiché tel quel. Ce n'est jamais un « aucun écart ».
 */

import type { PrismaClient } from '@prisma/client';

import { configuredSyncApps, readAppSecret, readAppUrl, signGet } from '@/lib/sync/discovery';
import type { IdentityAudit, IdentityAuditApp, SyncApp } from '@/lib/sync/types';

const TIMEOUT_MS = 10_000;

type LocalUser = { hub_user_id?: string | null; email?: string | null; name?: string | null };
type HubUser = { supabaseUserId: string | null; email: string; name: string | null; emailVerified?: Date | null };

function emptyAudit(status: IdentityAuditApp['status']): IdentityAuditApp {
  return { status, localAccounts: 0, withoutHub: [], unlinked: [], awaitingProof: [], horsPerimetre: [], emailMismatch: [], nameMismatch: [] };
}

/**
 * Comptes d'app volontairement sans utilisateur Hub, tranchés le 09/11 : témoins protégés et comptes
 * d'exploitation. Un compte qui n'est ici que par motif doit rester interne (`@veridian.site`).
 * Ajouter une entrée = la justifier ; un client n'y entre jamais (il se relie au Hub).
 */
export const HORS_PERIMETRE: Partial<Record<SyncApp, { motif: RegExp; raison: string }[]>> = {
  notifuse: [
    { motif: /^admin@veridian\.site$/, raison: 'administrateur racine de Notifuse (exploitation)' },
    { motif: /^canary(free|pro|enterprise)@veridian\.site$/, raison: 'canari protégé : témoin des plans, sonde de prod' },
    { motif: /^smoke@veridian\.site$/, raison: 'témoin du smoke de déploiement' },
    { motif: /^robert@(veridian\.site|agences-veridian\.fr)$/, raison: 'compte opérateur de Robert dans Notifuse, hors parcours client' },
  ],
  analytics: [{ motif: /^audit-ui@veridian\.site$/, raison: 'compte de l\'audit d\'interface (lecture), témoin' }],
};

function horsPerimetre(app: SyncApp | undefined, email: string): string | null {
  if (!app) return null;
  return HORS_PERIMETRE[app]?.find((h) => h.motif.test(email))?.raison ?? null;
}

/** Pure : classe les comptes locaux d'une app par rapport au Hub. */
export function compareIdentities(locals: LocalUser[], hubUsers: HubUser[], app?: SyncApp): IdentityAuditApp {
  const byId = new Map(hubUsers.flatMap((u) => (u.supabaseUserId ? [[u.supabaseUserId, u]] : [])));
  const byEmail = new Map(hubUsers.map((u) => [u.email.toLowerCase(), u]));
  const audit = emptyAudit('ok');

  for (const local of locals) {
    const email = (local.email ?? '').toLowerCase();
    if (!email) continue;
    audit.localAccounts += 1;

    const hubUser = local.hub_user_id ? byId.get(local.hub_user_id) : undefined;
    if (!hubUser) {
      // Aucun identifiant ou identifiant inconnu : une même adresse au Hub n'est qu'un
      // candidat au rattachement, jamais un lien acquis.
      const candidat = byEmail.get(email);
      const raison = candidat ? null : horsPerimetre(app, email);
      if (raison) audit.horsPerimetre!.push({ email, raison });
      else if (!candidat) audit.withoutHub.push(email);
      // `emailVerified` absent (appelant ancien) : on ne présume pas la preuve.
      else if (candidat.emailVerified) audit.unlinked.push(email);
      else audit.awaitingProof.push(email);
      continue;
    }
    if (hubUser.email.toLowerCase() !== email) audit.emailMismatch.push(email);
    if (local.name && hubUser.name && local.name !== hubUser.name) audit.nameMismatch.push(email);
  }
  return audit;
}

async function auditApp(
  app: SyncApp,
  hubUsers: HubUser[],
  fetchImpl: typeof fetch,
): Promise<IdentityAuditApp> {
  const url = readAppUrl(app);
  const secret = readAppSecret(app);
  if (!url || !secret) return emptyAudit('not_configured');

  const { timestamp, signature } = signGet(secret);
  try {
    const res = await fetchImpl(`${url}/api/hub/users`, {
      headers: { 'X-Veridian-Timestamp': timestamp, 'X-Veridian-Hub-Signature': signature },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return emptyAudit('endpoint_missing');
    }
    if (!res.ok) return emptyAudit('unreachable');
    const body = (await res.json().catch(() => null)) as { users?: LocalUser[] } | null;
    if (!Array.isArray(body?.users)) return emptyAudit('unreachable');
    return compareIdentities(body.users, hubUsers, app);
  } catch {
    return emptyAudit('unreachable');
  }
}

export async function auditIdentity(
  prisma: Pick<PrismaClient, 'user'>,
  opts: { apps?: readonly SyncApp[]; fetchImpl?: typeof fetch } = {},
): Promise<IdentityAudit> {
  const apps = opts.apps ?? configuredSyncApps();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hubUsers = await prisma.user.findMany({
    select: { supabaseUserId: true, email: true, name: true, emailVerified: true },
  });
  const results = await Promise.all(apps.map((app) => auditApp(app, hubUsers, fetchImpl)));
  return Object.fromEntries(apps.map((app, i) => [app, results[i]])) as IdentityAudit;
}

/** Version sans adresse : la réponse du cron part dans des logs Actions publics. */
export function identityCounts(audit: IdentityAudit | undefined) {
  if (!audit) return undefined;
  return Object.fromEntries(
    Object.entries(audit).map(([app, a]) => [
      app,
      {
        status: a.status,
        localAccounts: a.localAccounts,
        withoutHub: a.withoutHub.length,
        unlinked: a.unlinked.length,
        awaitingProof: a.awaitingProof.length,
        horsPerimetre: a.horsPerimetre?.length ?? 0,
        emailMismatch: a.emailMismatch.length,
        nameMismatch: a.nameMismatch.length,
      },
    ]),
  );
}
