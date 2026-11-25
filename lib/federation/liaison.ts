/**
 * Relier une identité d'organisation par SA personne (VER-261) : connectée au Hub par ses propres moyens, preuve récente, membre de l'organisation. Seul
 * l'identifiant (fournisseur, `sub`) compte : aucune adresse n'est crue, aucun compte n'est créé. Pour un fournisseur qui ne prouve pas les adresses
 * (Infomaniak : `email_verified` faux, adresses personnelles). Un `sub` = une personne ; une personne = un `sub` par fournisseur.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { membreVivant, type Titulaire } from '@/lib/adresses/federation';
import { isTestAccount } from '@/lib/sync/test-residue';

import { fournisseur } from './identite';
import { idpPret, type IdpPret } from './idp';
import { nomFournisseur } from './nom';
import type { Identite } from './oidc';

export type RefusLiaison = 'email_not_verified' | 'non_attendu' | 'autre_identite';
type Db = Pick<PrismaClient, 'account' | 'tenant' | 'tenantIdp' | 'tenantMember' | 'auditLog'>;

export { nomFournisseur };

/** Le fournisseur de CETTE organisation, pour cette personne. Null, une seule réponse : pas membre, pas de fournisseur, ou fermé. */
export async function fournisseurDe(db: Db, u: Titulaire, tenantId: string): Promise<IdpPret | null> {
  if (!u.supabaseUserId || !(await membreVivant(db, tenantId, u.supabaseUserId))) return null;
  const l = await db.tenantIdp.findUnique({ where: { tenantId }, select: { id: true } });
  const i = l ? await idpPret(db, { id: l.id }) : null;
  return i && i.test && !isTestAccount(u.email) ? null : i;
}

export type Liaison = { tenant_id: string; organisation: string; fournisseur: string; reliee: boolean };
export async function liaisonsDe(db: Db, u: Titulaire): Promise<Liaison[]> {
  if (!u.supabaseUserId) return [];
  const membre = await db.tenantMember.findMany({ where: { userId: u.supabaseUserId, deletedAt: null }, select: { tenantId: true } });
  const lus = await db.tenant.findMany({ where: { deletedAt: null, OR: [{ userId: u.supabaseUserId }, { id: { in: membre.map((m) => m.tenantId) } }] }, select: { id: true, name: true } });
  const res: Liaison[] = [];
  for (const t of lus) {
    const i = await fournisseurDe(db, u, t.id);
    if (i) res.push({ tenant_id: t.id, organisation: t.name, fournisseur: nomFournisseur(i.issuer), reliee: Boolean(await db.account.findFirst({ where: { userId: u.id, provider: fournisseur(i) }, select: { id: true } })) });
  }
  return res;
}

/** Au retour du fournisseur : tout est relu. */
export async function relierParPersonne(db: Db, i: IdpPret, x: Identite, u: Titulaire): Promise<{ reliee: true } | { refus: RefusLiaison }> {
  if (!u.emailVerified) return { refus: 'email_not_verified' };
  if (!u.supabaseUserId || (i.test && !isTestAccount(u.email)) || !(await membreVivant(db, i.tenantId, u.supabaseUserId))) return { refus: 'non_attendu' };
  const provider = fournisseur(i);
  const [lien, autre] = await Promise.all([
    db.account.findUnique({ where: { provider_providerAccountId: { provider, providerAccountId: x.sub } }, select: { userId: true } }),
    db.account.findFirst({ where: { userId: u.id, provider, NOT: { providerAccountId: x.sub } }, select: { id: true } }),
  ]);
  if ((lien && lien.userId !== u.id) || autre) return { refus: 'autre_identite' };
  if (!lien) {
    try {
      await db.account.create({ data: { userId: u.id, type: 'oidc', provider, providerAccountId: x.sub } });
    } catch (err) {
      // Deux personnes en même temps sur le même `sub` : la base n'en garde qu'une.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return { refus: 'autre_identite' };
    }
    await writeAuditLog(db as PrismaClient, { action: 'federation.relie', actor: `user:${u.id}`, targetType: 'user', targetId: u.id, payload: { tenant_id: i.tenantId, par: 'personne' } });
  }
  return { reliee: true };
}

/** Toujours possible : elle garde ses propres connexions, et la route n'est ouverte qu'à une session qui en vient. */
export async function delier(db: Db, u: Titulaire, tenantId: string): Promise<boolean> {
  const l = await db.tenantIdp.findUnique({ where: { tenantId }, select: { id: true } });
  if (!l) return false;
  const { count } = await db.account.deleteMany({ where: { userId: u.id, provider: fournisseur(l) } });
  if (count) await writeAuditLog(db as PrismaClient, { action: 'federation.delie', actor: `user:${u.id}`, targetType: 'user', targetId: u.id, payload: { tenant_id: tenantId } });
  return count > 0;
}
