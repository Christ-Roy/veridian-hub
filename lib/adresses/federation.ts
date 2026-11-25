/**
 * Une seconde adresse PROUVÉE PAR LE FOURNISSEUR d'une organisation (AD-M3, 25/11) : connectée au Hub, la personne repasse devant le fournisseur du
 * domaine et il affirme exactement l'adresse qu'elle a nommée. Aucune session n'en naît, aucun lien de connexion n'est posé : l'adresse est prouvée, rien de plus.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { adresseAffirmee, fournisseur, type RefusFederation } from '@/lib/federation/identite';
import { idpPret, type IdpPret } from '@/lib/federation/idp';
import type { Identite } from '@/lib/federation/oidc';
import { isTestAccount } from '@/lib/sync/test-residue';

import { ADRESSES_MAX } from './index';

export type Titulaire = { id: string; email: string; emailVerified: Date | null; supabaseUserId: string | null };
export type RefusAjout = RefusFederation | 'autre_adresse' | 'trop_d_adresses' | 'email_not_verified';
type Db = Pick<PrismaClient, 'user' | 'userEmail' | 'account' | 'tenant' | 'tenantIdp' | 'tenantMember' | 'auditLog'>;

/** Ce que dit la ligne d'une adresse affirmée par l'organisation : l'organisation, pas la ligne du fournisseur, qui se repose avec un autre id. */
export const preuveOrganisation = (tenantId: string): string => `org:${tenantId}`;

export async function membreVivant(db: Pick<PrismaClient, 'tenant' | 'tenantMember'>, tenantId: string, hubUserId: string): Promise<boolean> {
  if (await db.tenantMember.findFirst({ where: { tenantId, userId: hubUserId, deletedAt: null }, select: { userId: true } })) return true;
  return Boolean(await db.tenant.findFirst({ where: { id: tenantId, userId: hubUserId, deletedAt: null }, select: { id: true } }));
}

/** Le fournisseur actif qui tient le domaine de cette adresse. Celui d'une organisation de test ne tient que des comptes de batterie. */
export async function idpDuDomaine(db: Pick<PrismaClient, 'tenant' | 'tenantIdp'>, brut: string): Promise<IdpPret | null> {
  const email = normaliserEmail(brut);
  const i = await db.tenantIdp.findFirst({ where: { actif: true, domaines: { has: email.split('@')[1] ?? '' } }, select: { id: true } });
  const pret = i ? await idpPret(db, { id: i.id }) : null;
  return pret && pret.test && !isTestAccount(email) ? null : pret;
}

/** Le fournisseur devant lequel la personne peut prouver cette adresse. Null, une seule réponse : domaine inconnu, ou organisation dont elle n'est pas. */
export async function fournisseurPour(db: Db, u: Titulaire, email: string): Promise<IdpPret | null> {
  const i = await idpDuDomaine(db, email);
  if (!i || !u.supabaseUserId || (i.test && !isTestAccount(u.email))) return null;
  return (await membreVivant(db, i.tenantId, u.supabaseUserId)) ? i : null;
}

/** Tout est relu au retour : membre, domaine, adresse affirmée, identité qui ne sert à personne d'autre. La base tient l'unicité de l'adresse. */
export async function ajouterParFournisseur(db: Db, i: IdpPret, x: Identite, u: Titulaire, attendue: string, now = new Date()): Promise<{ ajoutee: string } | { refus: RefusAjout }> {
  if (!u.emailVerified) return { refus: 'email_not_verified' };
  const a = adresseAffirmee(i, x);
  if ('refus' in a) return a;
  if (a.email !== normaliserEmail(attendue)) return { refus: 'autre_adresse' };
  if (!u.supabaseUserId || (i.test && !isTestAccount(u.email)) || !(await membreVivant(db, i.tenantId, u.supabaseUserId))) return { refus: 'non_attendu' };
  const provider = fournisseur(i);
  const [lien, autre, siennes] = await Promise.all([
    db.account.findUnique({ where: { provider_providerAccountId: { provider, providerAccountId: x.sub } }, select: { userId: true } }),
    db.account.findFirst({ where: { userId: u.id, provider, NOT: { providerAccountId: x.sub } }, select: { id: true } }),
    db.userEmail.count({ where: { userId: u.id, detacheeLe: null } }),
  ]);
  if ((lien && lien.userId !== u.id) || autre) return { refus: 'autre_identite' };
  if (siennes >= ADRESSES_MAX) return { refus: 'trop_d_adresses' };
  try {
    await db.userEmail.create({ data: { userId: u.id, email: a.email, preuve: preuveOrganisation(i.tenantId), prouveeLe: now } });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    return { refus: 'compte_existant' };
  }
  await writeAuditLog(db as PrismaClient, { action: 'adresse.ajoutee', actor: `user:${u.id}`, targetType: 'user', targetId: u.id, payload: { preuve: 'organisation', tenant_id: i.tenantId } });
  return { ajoutee: a.email };
}
