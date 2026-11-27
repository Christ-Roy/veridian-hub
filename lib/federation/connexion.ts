/**
 * Régler la connexion d'une organisation : libre, ou obligatoire par son fournisseur, et qui garde son accès habituel (VER-261). Jamais de piège : obligatoire
 * demande un fournisseur actif et un accès de secours, et le dernier accès de secours ne s'enlève pas tant que c'est obligatoire.
 */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { pushUserToApps } from '@/lib/identity/push-user';

import { DOMAINES_PUBLICS, DOMAINES_VERIDIAN } from './idp';
import { fermees, type DbObligation } from './obligation';
import { estDeTest } from '@/lib/tenants/marque-test';

export const Aiguillage = z.array(z.string().trim().toLowerCase().max(253).regex(/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/)).max(20);
export type Nature = 'rattachement' | 'secours';
export type RefusConnexion = 'tenant_introuvable' | 'fournisseur_absent' | 'secours_manquant' | 'dernier_secours' | 'pas_membre' | 'absente' | 'domaine_public' | 'domaine_veridian' | 'domaine_pris' | 'deja_reliee';
type Db = DbObligation & Pick<PrismaClient, 'user' | 'auditLog'>;

const membre = async (db: Db, tenantId: string, hubUserId: string): Promise<boolean> =>
  (await db.tenant.findFirst({ where: { id: tenantId, userId: hubUserId, deletedAt: null }, select: { id: true } })) !== null || (await db.tenantMember.findFirst({ where: { tenantId, userId: hubUserId, deletedAt: null }, select: { tenantId: true } })) !== null;

/** Les accès de secours qui ouvrent vraiment : encore propriétaire ou membre. */
async function secours(db: Db, tenantId: string): Promise<string[]> {
  const l = await db.connexionExemption.findMany({ where: { tenantId, nature: 'secours', leveLe: null }, select: { hubUserId: true } });
  const res: string[] = [];
  for (const x of l) if (await membre(db, tenantId, x.hubUserId)) res.push(x.hubUserId);
  return res;
}

export async function poserExemption(db: DbObligation & Pick<PrismaClient, 'auditLog'>, d: { tenantId: string; hubUserId: string; nature: Nature; acteur: string }, now = new Date()): Promise<{ ok: true } | { refus: RefusConnexion }> {
  if (!(await membre(db as Db, d.tenantId, d.hubUserId))) return { refus: 'pas_membre' };
  const i = await db.tenantIdp.findUnique({ where: { tenantId: d.tenantId }, select: { id: true } });
  // « Jusqu'au rattachement » n'a pas de sens pour qui l'est déjà : elle ne rouvrirait rien, et resterait affichée pour rien.
  if (d.nature === 'rattachement' && i && (await db.account.findFirst({ where: { provider: `org:${i.id}`, user: { supabaseUserId: d.hubUserId } }, select: { id: true } }))) return { refus: 'deja_reliee' };
  const avant = await db.connexionExemption.findUnique({ where: { tenantId_hubUserId: { tenantId: d.tenantId, hubUserId: d.hubUserId } } });
  if (avant && !avant.leveLe && avant.nature === d.nature) return { ok: true };
  // Un accès de secours ne devient pas un accès « jusqu'au rattachement » s'il est le dernier.
  if (avant && !avant.leveLe && avant.nature === 'secours' && (await dernier(db as Db, d.tenantId, d.hubUserId))) return { refus: 'dernier_secours' };
  const neuf = { nature: d.nature, posePar: d.acteur, poseLe: now, leveLe: null, leveMotif: null };
  await db.connexionExemption.upsert({ where: { tenantId_hubUserId: { tenantId: d.tenantId, hubUserId: d.hubUserId } }, create: { tenantId: d.tenantId, hubUserId: d.hubUserId, ...neuf }, update: neuf });
  await writeAuditLog(db as PrismaClient, { action: 'connexion.exemption_posee', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { hub_user_id: d.hubUserId, nature: d.nature } });
  return { ok: true };
}

async function dernier(db: Db, tenantId: string, hubUserId: string): Promise<boolean> {
  if (!(await db.tenantConnexion.findFirst({ where: { tenantId, obligatoire: true }, select: { tenantId: true } }))) return false;
  const s = await secours(db, tenantId);
  return s.includes(hubUserId) && s.length === 1;
}

export async function leverExemption(db: Db, d: { tenantId: string; hubUserId: string; acteur: string }, now = new Date()): Promise<{ ok: true } | { refus: RefusConnexion }> {
  const x = await db.connexionExemption.findUnique({ where: { tenantId_hubUserId: { tenantId: d.tenantId, hubUserId: d.hubUserId } } });
  if (!x || x.leveLe) return { refus: 'absente' };
  if (x.nature === 'secours' && (await dernier(db, d.tenantId, d.hubUserId))) return { refus: 'dernier_secours' };
  await db.connexionExemption.updateMany({ where: { tenantId: d.tenantId, hubUserId: d.hubUserId, leveLe: null }, data: { leveLe: now, leveMotif: 'retiree' } });
  await writeAuditLog(db as PrismaClient, { action: 'connexion.exemption_levee', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { hub_user_id: d.hubUserId, nature: x.nature } });
  await couperFermes(db, d.tenantId, [d.hubUserId]);
  return { ok: true };
}

/** Une session d'app déjà ouverte est une porte : elle tombe pour ceux que l'organisation n'ouvre plus. Ils la rouvrent par le Hub. Rien pour les exemptés. */
async function couperFermes(db: Db, tenantId: string, gens: string[]): Promise<string[]> {
  const coupes: string[] = [];
  for (const g of gens) {
    if (!(await fermees(db, g, { par: 'personne' })).some((f) => f.tenantId === tenantId)) continue;
    await pushUserToApps({ hubUserId: g, revokeSessions: true }).catch((err) => console.error('[connexion] sessions', err instanceof Error ? err.message.slice(0, 160) : 'erreur'));
    coupes.push(g);
  }
  return coupes;
}

const gens = async (db: Db, tenantId: string): Promise<{ hubUserId: string; role: string }[]> => {
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { userId: true } });
  const m = await db.tenantMember.findMany({ where: { tenantId, deletedAt: null }, select: { userId: true, role: true } });
  return t ? [{ hubUserId: t.userId, role: 'owner' }, ...m.filter((x) => x.userId !== t.userId).map((x) => ({ hubUserId: x.userId, role: x.role }))] : [];
};

export async function reglerConnexion(db: Db, d: { tenantId: string; obligatoire?: boolean; aiguillage?: string[]; acteur: string; /** Le propriétaire qui l'active : à défaut d'un autre, il est l'accès de secours. */ proprietaire?: string }): Promise<{ ok: true; coupes: string[] } | { refus: RefusConnexion }> {
  const t = await db.tenant.findFirst({ where: { id: d.tenantId, deletedAt: null }, select: { metadata: true } });
  if (!t) return { refus: 'tenant_introuvable' };
  const avant = await db.tenantConnexion.findUnique({ where: { tenantId: d.tenantId } });
  const aiguillage = d.aiguillage ? Array.from(new Set(d.aiguillage)) : (avant?.aiguillage ?? []);
  if (d.aiguillage) {
    if (aiguillage.some((x) => DOMAINES_PUBLICS.has(x))) return { refus: 'domaine_public' };
    if (aiguillage.some((x) => DOMAINES_VERIDIAN.test(x)) && !estDeTest(t.metadata)) return { refus: 'domaine_veridian' };
    if (aiguillage.length && (await db.tenantConnexion.findFirst({ where: { aiguillage: { hasSome: aiguillage }, NOT: { tenantId: d.tenantId } }, select: { tenantId: true } }))) return { refus: 'domaine_pris' };
  }
  const obligatoire = d.obligatoire ?? avant?.obligatoire ?? false;
  if (obligatoire && !avant?.obligatoire) {
    const i = await db.tenantIdp.findUnique({ where: { tenantId: d.tenantId }, select: { actif: true } });
    if (!i?.actif) return { refus: 'fournisseur_absent' };
    if ((await secours(db, d.tenantId)).length === 0) {
      if (!d.proprietaire) return { refus: 'secours_manquant' };
      await poserExemption(db, { tenantId: d.tenantId, hubUserId: d.proprietaire, nature: 'secours', acteur: d.acteur });
    }
  }
  const ligne = { obligatoire, aiguillage, majPar: d.acteur, majLe: new Date() };
  await db.tenantConnexion.upsert({ where: { tenantId: d.tenantId }, create: { tenantId: d.tenantId, ...ligne }, update: ligne });
  await writeAuditLog(db as PrismaClient, { action: obligatoire ? 'connexion.obligatoire' : 'connexion.libre', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { avant: avant?.obligatoire ?? false, aiguillage } });
  const coupes = obligatoire && !avant?.obligatoire ? await couperFermes(db, d.tenantId, (await gens(db, d.tenantId)).map((g) => g.hubUserId)) : [];
  return { ok: true, coupes };
}

export type EtatPersonne = { hub_user_id: string; email: string; role: string; reliee: boolean; exemption: Nature | null; exemption_depuis: string | null; exemption_tombee_le: string | null; /** Si c'était obligatoire maintenant : elle passe par le fournisseur, ou garde son accès. */ acces: 'secours' | 'actuel' | 'fournisseur' | 'ferme' };
export type EtatConnexion = { obligatoire: boolean; aiguillage: string[]; maj_par: string | null; maj_le: string | null; fournisseur_actif: boolean; personnes: EtatPersonne[] };

/** Ce que l'écran et `hub org connexion` montrent : qui entre comment. */
export async function etatConnexion(db: Db, tenantId: string): Promise<EtatConnexion> {
  const [c, i, x, g] = await Promise.all([db.tenantConnexion.findUnique({ where: { tenantId } }), db.tenantIdp.findUnique({ where: { tenantId }, select: { id: true, actif: true } }), db.connexionExemption.findMany({ where: { tenantId } }), gens(db, tenantId)]);
  const comptes = await db.user.findMany({ where: { supabaseUserId: { in: g.map((y) => y.hubUserId) } }, select: { id: true, email: true, supabaseUserId: true } });
  const relies = i ? await db.account.findMany({ where: { provider: `org:${i.id}`, userId: { in: comptes.map((u) => u.id) } }, select: { userId: true } }) : [];
  return {
    obligatoire: c?.obligatoire ?? false, aiguillage: c?.aiguillage ?? [], maj_par: c?.majPar ?? null, maj_le: c?.majLe.toISOString() ?? null, fournisseur_actif: i?.actif === true,
    personnes: g.map((y) => {
      const u = comptes.find((z) => z.supabaseUserId === y.hubUserId);
      const e = x.find((z) => z.hubUserId === y.hubUserId);
      const reliee = Boolean(u && relies.some((r) => r.userId === u.id));
      const vive = e && !e.leveLe && (e.nature === 'secours' || !reliee) ? (e.nature as Nature) : null;
      return { hub_user_id: y.hubUserId, email: u?.email ?? 'compte inconnu', role: y.role, reliee, exemption: vive, exemption_depuis: vive ? e!.poseLe.toISOString() : null, exemption_tombee_le: e?.leveLe?.toISOString() ?? null, acces: vive === 'secours' ? 'secours' : vive ? 'actuel' : reliee && i?.actif ? 'fournisseur' : 'ferme' };
    }),
  };
}

/** La page de connexion : où envoyer une adresse, d'après son SEUL domaine. Rien n'est lu du compte : la réponse est la même pour une adresse inconnue. */
export async function aiguiller(db: Pick<PrismaClient, 'tenantConnexion' | 'tenantIdp' | 'tenant'>, email: string): Promise<{ tenantId: string; porte: string } | null> {
  const domaine = email.trim().toLowerCase().split('@')[1] ?? '';
  if (!domaine || email.split('@').length !== 2) return null;
  const c = await db.tenantConnexion.findFirst({ where: { obligatoire: true, aiguillage: { has: domaine } }, select: { tenantId: true } });
  if (!c) return null;
  const [i, t] = await Promise.all([db.tenantIdp.findUnique({ where: { tenantId: c.tenantId }, select: { actif: true, alias: true } }), db.tenant.findFirst({ where: { id: c.tenantId, deletedAt: null, status: { notIn: ['suspended', 'deleted'] } }, select: { slug: true } })]);
  return i?.actif && t ? { tenantId: c.tenantId, porte: i.alias ?? t.slug } : null;
}
