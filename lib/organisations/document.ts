/**
 * Le document d'organisation (VER-252) : une seule configuration, au Hub, que chaque app reçoit. Tout vient d'ici : nom, type, marque,
 * modules, membres. La liste des membres est ADDITIVE : une absence ne retire personne (le retrait reste `remove-member`, relu).
 */
import { createHash } from 'node:crypto';

import type { Organisation, PrismaClient } from '@prisma/client';

import { roleOrg, type RoleOrg } from '@/lib/tenants/roles';

export const TYPES = ['individuel', 'organisation'] as const;
/** Apps qui savent recevoir le document. Rien ne part vers une app tant que l'organisation ne l'a pas cochée (Mail : cocher RENOMME l'espace). */
// Analytics : POST|GET /api/hub/organisations/sync servis depuis 5ff5e08d8 (27/11, 21/21 mesuré par Analytics en prod).
export const MODULES = ['academy', 'notifuse', 'prospection', 'crm', 'analytics'] as const;
export type Module = (typeof MODULES)[number];
export const COULEUR = /^#[0-9a-fA-F]{6}$/;

export type MembreOrg = { hub_user_id: string; email: string; email_proven: true; name: string | null; role: RoleOrg; joined_at: string };
export type DocumentOrg = {
  hub_tenant_id: string;
  version: number;
  nom: string;
  type: (typeof TYPES)[number];
  marque: { nom_affiche: string | null; logo_url: string | null; logo_sombre_url: null; favicon_url: null; couleur_primaire: string | null; couleur_accent: string | null };
  modules: string[];
  membres: MembreOrg[];
  reglages: Record<string, unknown>;
};
type Db = Pick<PrismaClient, 'organisation' | 'tenant' | 'tenantMember' | 'user'>;

export const urlLogo = (base: string, o: Pick<Organisation, 'tenantId' | 'logoEmpreinte'>): string | null => (o.logoEmpreinte ? `${base}/api/public/org/${o.tenantId}/logo?v=${o.logoEmpreinte}` : null);

/** Propriétaire puis membres vivants, adresses prouvées seulement. `joined_at` = l'adhésion EN VIGUEUR, jamais celle d'avant un retrait. */
async function membresDe(db: Db, t: { id: string; userId: string; createdAt: Date }): Promise<MembreOrg[]> {
  const lignes = await db.tenantMember.findMany({ where: { tenantId: t.id, deletedAt: null }, select: { userId: true, role: true, joinedAt: true } });
  const tous = [{ userId: t.userId, role: 'owner', joinedAt: t.createdAt }, ...lignes.filter((l) => l.userId !== t.userId)];
  const comptes = await db.user.findMany({ where: { supabaseUserId: { in: tous.map((x) => x.userId) } }, select: { supabaseUserId: true, email: true, name: true, emailVerified: true } });
  return tous.flatMap((m) => {
    const u = comptes.find((c) => c.supabaseUserId === m.userId);
    return u?.emailVerified ? [{ hub_user_id: m.userId, email: u.email.toLowerCase(), email_proven: true as const, name: u.name, role: roleOrg(m.role), joined_at: m.joinedAt.toISOString() }] : [];
  }).sort((a, b) => a.hub_user_id.localeCompare(b.hub_user_id));
}

/**
 * Le contenu tel qu'il serait émis AUJOURD'HUI, sans rien écrire (le relevé `hub reconcile` le lit ainsi). Null si l'organisation n'est pas
 * réglée au Hub ou n'est plus vivante. `empreinteStockee` : celle de la dernière version posée ; différente = contenu non encore versionné.
 */
export async function contenuOrg(db: Db, tenantId: string, base: string): Promise<{ contenu: Omit<DocumentOrg, 'version'>; empreinte: string; version: bigint; empreinteStockee: string | null } | null> {
  const o = await db.organisation.findUnique({ where: { tenantId } });
  const t = o ? await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true, userId: true, name: true, status: true, createdAt: true } }) : null;
  if (!o || !t || t.status === 'suspended' || t.status === 'deleted') return null;
  const contenu = {
    hub_tenant_id: t.id,
    nom: o.nomAffiche ?? t.name,
    type: o.type === 'organisation' ? ('organisation' as const) : ('individuel' as const),
    // Choisi par le propriétaire, ou null : le nom par défaut d'un compte n'est jamais un choix, une app ne s'en renomme pas (Notifuse, 25/11).
    marque: { nom_affiche: o.nomAffiche, logo_url: urlLogo(base, o), logo_sombre_url: null, favicon_url: null, couleur_primaire: o.couleurPrimaire, couleur_accent: o.couleurAccent },
    modules: [...o.modules].sort(),
    membres: await membresDe(db, t),
    reglages: (o.reglages ?? {}) as Record<string, unknown>,
  };
  const empreinte = createHash('sha256').update(JSON.stringify(contenu)).digest('hex').slice(0, 32);
  return { contenu, empreinte, version: o.version, empreinteStockee: o.empreinte };
}

/**
 * Le document courant, ou null (voir `contenuOrg`). La version ne bouge que si le contenu bouge, et ne recule jamais.
 */
export async function documentOrg(db: Db, tenantId: string, base: string): Promise<DocumentOrg | null> {
  const c = await contenuOrg(db, tenantId, base);
  if (!c) return null;
  let version = Number(c.version);
  if (c.empreinte !== c.empreinteStockee) {
    version = Math.max(Date.now(), version + 1);
    await db.organisation.update({ where: { tenantId }, data: { version: BigInt(version), empreinte: c.empreinte } });
  }
  return { ...c.contenu, version };
}

/** Le document tel qu'UNE app le reçoit : les réglages des autres ne la regardent pas. */
export const pourApp = (d: DocumentOrg, app: string): DocumentOrg => ({ ...d, reglages: d.reglages[app] !== undefined ? { [app]: d.reglages[app] } : {} });
