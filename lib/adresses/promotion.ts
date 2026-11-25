/**
 * Rendre principale une adresse secondaire PROUVÉE (AD-M3, 25/11). La personne est son `hub_user_id` : il ne bouge pas, les apps suivent par lui.
 * L'ancienne principale reste une adresse secondaire : reconnue comme avant, elle n'ouvre plus de session et se détache. Tout ou rien : une app qui
 * refuse la nouvelle adresse (déjà prise chez elle) ou ne répond pas remet tout comme avant.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { revokeAllSessions } from '@/lib/auth/session-revocation';
import { pushUserToApps } from '@/lib/identity/push-user';
import { suivreAdresseMail } from '@/lib/notifuse/adresse';
import { suivreOrganisation } from '@/lib/organisations/emission';
import type { SyncApp } from '@/lib/sync/types';

import { idpDuDomaine, membreVivant, preuveOrganisation, type Titulaire } from './federation';
import { verifierApps, type RefusApp } from './garde';

export type RefusPromotion = 'not_found' | 'email_not_verified' | 'domaine_federe' | 'preuve_perdue' | 'app_refuse' | 'prise' | RefusApp;
export type Promotion = { promue: string; appsEnEchec: string[] } | { refus: RefusApp; apps: SyncApp[] } | { refus: Exclude<RefusPromotion, RefusApp>; apps?: SyncApp[] };
type Deps = { fetchImpl?: typeof fetch; apps?: readonly SyncApp[]; now?: Date };
type Ligne = { id: string; email: string; preuve: string; prouveeLe: Date };

/** Un domaine tenu par le fournisseur d'une organisation : elle seule prouve ses adresses, et à ses membres seulement. */
async function refusDePreuve(db: PrismaClient, hubUserId: string, l: Ligne): Promise<'domaine_federe' | 'preuve_perdue' | null> {
  const i = await idpDuDomaine(db, l.email);
  if (!i) return l.preuve.startsWith('org:') ? 'preuve_perdue' : null;
  if (l.preuve !== preuveOrganisation(i.tenantId) && l.preuve !== 'principale') return 'domaine_federe';
  return (await membreVivant(db, i.tenantId, hubUserId)) ? null : 'domaine_federe';
}

async function echanger(db: PrismaClient, u: Titulaire, l: Ligne, now: Date): Promise<string | null> {
  const ancienne = normaliserEmail(u.email);
  try {
    return await db.$transaction(async (tx) => {
      const prise = await tx.userEmail.updateMany({ where: { id: l.id, userId: u.id, detacheeLe: null }, data: { detacheeLe: now, detacheePar: 'promotion' } });
      const posee = await tx.user.updateMany({ where: { id: u.id, email: u.email }, data: { email: l.email, emailVerified: l.prouveeLe } });
      // Deux promotions en même temps : une seule trouve sa ligne et l'adresse d'avant.
      if (prise.count !== 1 || posee.count !== 1) throw Object.assign(new Error('rejouee'), { code: 'REJOUEE' });
      const alias = await tx.userEmail.create({ data: { userId: u.id, email: ancienne, preuve: 'principale', prouveeLe: u.emailVerified ?? now }, select: { id: true } });
      await tx.account.updateMany({ where: { userId: u.id, provider: 'credentials' }, data: { providerAccountId: l.email } });
      // Un lien de connexion, de preuve ou de mot de passe parti à l'ancienne adresse ne vaut plus rien.
      await tx.verificationToken.deleteMany({ where: { identifier: { in: [u.email, ancienne] } } });
      return alias.id;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'REJOUEE') return null;
    throw err;
  }
}

async function remettre(db: PrismaClient, u: Titulaire, l: Ligne, aliasId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.userEmail.delete({ where: { id: aliasId } });
    await tx.user.update({ where: { id: u.id }, data: { email: u.email, emailVerified: u.emailVerified } });
    await tx.userEmail.update({ where: { id: l.id }, data: { detacheeLe: null, detacheePar: null } });
    await tx.account.updateMany({ where: { userId: u.id, provider: 'credentials' }, data: { providerAccountId: u.email } });
  });
}

export async function promouvoir(db: PrismaClient, u: Titulaire, brut: string, deps: Deps = {}): Promise<Promotion> {
  const now = deps.now ?? new Date();
  if (!u.emailVerified || !u.supabaseUserId) return { refus: 'email_not_verified' };
  const hubUserId = u.supabaseUserId;
  const l = await db.userEmail.findFirst({ where: { userId: u.id, email: normaliserEmail(brut), detacheeLe: null }, select: { id: true, email: true, preuve: true, prouveeLe: true } });
  if (!l) return { refus: 'not_found' };
  const preuve = await refusDePreuve(db, hubUserId, l);
  if (preuve) return { refus: preuve };
  const chez = await verifierApps({ hubUserId, email: u.email }, deps);
  if ('refus' in chez) return chez;

  let aliasId: string | null;
  try {
    aliasId = await echanger(db, u, l, now);
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { refus: 'prise' };
    throw err;
  }
  if (!aliasId) return { refus: 'not_found' };

  const suivent = chez.reliees;
  const issues = await pushUserToApps({ hubUserId, email: l.email }, { apps: suivent, fetchImpl: deps.fetchImpl });
  const refusent = suivent.filter((a) => issues[a] !== 'ok');
  if (refusent.length) {
    await remettre(db, u, l, aliasId);
    const retour = await pushUserToApps({ hubUserId, email: normaliserEmail(u.email) }, { apps: suivent, fetchImpl: deps.fetchImpl });
    console.error(JSON.stringify({ tag: '[adresse][promotion-refusee]', level: 'error', hub_user_id: hubUserId, issues, retour }));
    await writeAuditLog(db, { action: 'adresse.promotion_refusee', actor: `user:${u.id}`, targetType: 'user', targetId: u.id, payload: { apps: refusent, retour } });
    return { refus: 'app_refuse', apps: refusent };
  }
  if (issues.notifuse === 'ok') await suivreAdresseMail(db, hubUserId, l.email);
  await writeAuditLog(db, { action: 'adresse.promue', actor: `user:${u.id}`, targetType: 'user', targetId: u.id, payload: { preuve: l.preuve, apps: issues } });
  const orgs = await db.tenantMember.findMany({ where: { userId: hubUserId, deletedAt: null }, select: { tenantId: true } });
  for (const o of orgs) await suivreOrganisation(db, o.tenantId, { fetchImpl: deps.fetchImpl });
  // Les sessions ouvertes portent l'ancienne adresse : elles tombent, au Hub comme dans les apps. On se reconnecte avec la nouvelle.
  const { appsEnEchec } = await revokeAllSessions(db, { id: u.id, supabaseUserId: hubUserId });
  return { promue: l.email, appsEnEchec };
}
