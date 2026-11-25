/**
 * Changement d'adresse principale : l'ANCIENNE adresse est prévenue, et peut annuler 72 h (AD-M3, VER-227). C'est la sortie de secours de quelqu'un à qui
 * on a pris sa session : le lien ne part qu'à cette adresse, sert une fois, et sur un geste (POST), jamais à l'ouverture. Annuler rend l'adresse, retire
 * celles venues avec le changement, et TOUT ce qui ouvrait le compte (mot de passe, fournisseurs, sessions, IA) : on ne sait pas qui les a posés.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { revokeAllSessions } from '@/lib/auth/session-revocation';
import { sendMail } from '@/lib/email/send';
import { renderAdresseAnnuleeEmail, renderAdresseChangeeEmail } from '@/lib/email/templates/adresse-changee';
import { pushUserToApps } from '@/lib/identity/push-user';
import { suivreAdresseMail } from '@/lib/notifuse/adresse';
import { getURL } from '@/utils/helpers';

export const ANNULATION_H = 72;
const FENETRE_MS = ANNULATION_H * 3_600_000;
/** Une adresse ajoutée la veille du changement est venue avec lui. */
const VEILLE_MS = 24 * 3_600_000;
const PREFIXE = 'annuler-adresse:';
const du = (userId: string): string => `${PREFIXE}${userId}:`;
const empreinte = (t: string): string => createHash('sha256').update(`annuler:${t}`).digest('hex');

type Db = Pick<PrismaClient, 'verificationToken'>;
type Deps = { send?: typeof sendMail; now?: number; fetchImpl?: typeof fetch };

/** Prévient l'ancienne adresse, qui garde 72 h pour annuler. `aliasId` : sa ligne d'adresse secondaire. */
export async function prevenirAncienne(db: Db, d: { userId: string; ancienne: string; aliasId: string }, deps: Deps = {}): Promise<void> {
  const jeton = randomBytes(32).toString('base64url');
  const now = deps.now ?? Date.now();
  await db.verificationToken.create({ data: { identifier: `${du(d.userId)}${d.aliasId}`, token: empreinte(jeton), expires: new Date(now + FENETRE_MS) } });
  await (deps.send ?? sendMail)({ to: d.ancienne, ...renderAdresseChangeeEmail({ lien: `${getURL()}/auth/adresse?token=${encodeURIComponent(jeton)}`, heures: ANNULATION_H }) });
}

/** Cette adresse peut-elle encore annuler ? Tant que oui, personne ne la détache : ce serait fermer la sortie de secours. */
export async function annulationOuverte(db: Db, userId: string, aliasId: string, now = new Date()): Promise<boolean> {
  return (await db.verificationToken.count({ where: { identifier: `${du(userId)}${aliasId}`, expires: { gt: now } } })) > 0;
}

export async function annuler(db: PrismaClient, jeton: unknown, deps: Deps = {}): Promise<{ rendue: true; appsEnEchec: string[] } | { refus: 'invalide' | 'prise' }> {
  if (typeof jeton !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jeton)) return { refus: 'invalide' };
  const now = new Date(deps.now ?? Date.now());
  const l = await db.verificationToken.findUnique({ where: { token: empreinte(jeton) } });
  if (!l?.identifier.startsWith(PREFIXE) || l.expires <= now) return { refus: 'invalide' };
  const [userId, aliasId] = l.identifier.slice(PREFIXE.length).split(':');
  const change = l.expires.getTime() - FENETRE_MS;
  let fait: { email: string; quittee: string; hubUserId: string | null };
  try {
    fait = await db.$transaction(async (tx) => {
      // Une seule fois : la suppression est l'acte.
      if ((await tx.verificationToken.deleteMany({ where: { token: l.token, identifier: l.identifier } })).count !== 1) throw Object.assign(new Error('rejouee'), { code: 'INVALIDE' });
      const u = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, supabaseUserId: true } });
      const a = await tx.userEmail.findFirst({ where: { id: aliasId, userId, detacheeLe: null }, select: { id: true, email: true, prouveeLe: true } });
      if (!u || !a) throw Object.assign(new Error('absente'), { code: 'INVALIDE' });
      const detacher = { detacheeLe: now, detacheePar: 'annulation' };
      await tx.userEmail.update({ where: { id: a.id }, data: detacher });
      // Venues avec le changement, ou principales depuis : elles partent toutes.
      await tx.userEmail.updateMany({ where: { userId, detacheeLe: null, OR: [{ preuve: 'principale' }, { prouveeLe: { gte: new Date(change - VEILLE_MS) } }] }, data: detacher });
      await tx.user.update({ where: { id: userId }, data: { email: a.email, emailVerified: a.prouveeLe } });
      await tx.account.deleteMany({ where: { userId } });
      await tx.verificationToken.deleteMany({ where: { OR: [{ identifier: { startsWith: du(userId) } }, { identifier: { startsWith: `email-proof:${userId}:` } }, { identifier: { in: [u.email, normaliserEmail(u.email)] } }] } });
      return { email: a.email, quittee: u.email, hubUserId: u.supabaseUserId };
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'INVALIDE') return { refus: 'invalide' };
    if (code === 'P2002') return { refus: 'prise' };
    throw err;
  }
  // Le Hub d'abord, quoi que disent les apps : une app en retard se lit dans le journal et dans `hub reconcile`.
  const { appsEnEchec } = await revokeAllSessions(db, { id: userId, supabaseUserId: fait.hubUserId });
  const issues = fait.hubUserId ? await pushUserToApps({ hubUserId: fait.hubUserId, email: fait.email }, { fetchImpl: deps.fetchImpl }) : {};
  if (issues.notifuse === 'ok' && fait.hubUserId) await suivreAdresseMail(db, fait.hubUserId, fait.email);
  await writeAuditLog(db, { action: 'adresse.changement_annule', actor: 'system:annulation', targetType: 'user', targetId: userId, payload: { apps: issues } });
  await (deps.send ?? sendMail)({ to: fait.quittee, ...renderAdresseAnnuleeEmail() }).catch((err) => console.error('[adresse][annulation] avis', err instanceof Error ? err.message.slice(0, 120) : 'erreur'));
  return { rendue: true, appsEnEchec };
}
