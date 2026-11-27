/**
 * Connexion obligatoire par le fournisseur d'une organisation (VER-261, Robert 25/11). Une seule question, posée à toutes les portes : « quelles organisations
 * de cette personne CETTE preuve n'ouvre-t-elle pas ? ». La preuve est un paramètre obligatoire des lectures d'espaces : une porte qui l'oublie ne compile pas.
 * Les autres organisations de la personne restent ouvertes. Une lecture ratée lève : jamais ouverte par erreur.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';

import { federationExpiree, joursValables, SESSION_FEDEREE_MAX_S, type PreuveOrg } from './duree';
import { nomFournisseur } from './nom';

export type Preuve =
  /** Une session du Hub : ouverte par le fournisseur (`federeOrg`), ou la sienne, passée par lui (`preuves`). */
  | { par: 'session'; federeOrg?: string; preuves?: Record<string, PreuveOrg> }
  /** Un jeton donné à une IA : les organisations prouvées quand il a été donné. */
  | { par: 'jeton'; orgs: string[] }
  /** Aucune session (une app, un atelier) : le dernier passage de la personne par le fournisseur. */
  | { par: 'personne' }
  /** La fiche d'un client lue par un administrateur de la plateforme : une lecture, jamais une porte. */
  | { par: 'operateur' };

export type Fermee = { tenantId: string; nom: string; fournisseur: string; porte: string; proprietaire: boolean };
export type DbObligation = Pick<PrismaClient, 'tenantConnexion' | 'connexionExemption' | 'connexionPreuve' | 'tenant' | 'tenantMember' | 'tenantIdp' | 'account' | 'organisation'>;

/** `null` ou illisible : une session sans aucune preuve. Une session d'emprunt n'en porte jamais. */
export function preuveDeSession(s: { user?: { federeOrg?: string; preuves?: Record<string, PreuveOrg>; impersonated?: boolean } } | null | undefined): Preuve {
  if (!s?.user || s.user.impersonated === true) return { par: 'session' };
  return { par: 'session', federeOrg: s.user.federeOrg, preuves: s.user.preuves };
}

export async function fermees(db: DbObligation, hubUserId: string, preuve: Preuve, now = Date.now()): Promise<Fermee[]> {
  if (preuve.par === 'operateur') return [];
  const regles = await db.tenantConnexion.findMany({ where: { obligatoire: true }, select: { tenantId: true } });
  if (regles.length === 0) return [];
  const ids = regles.map((r) => r.tenantId);
  const membre = await db.tenantMember.findMany({ where: { userId: hubUserId, deletedAt: null, tenantId: { in: ids } }, select: { tenantId: true } });
  const orgs = await db.tenant.findMany({ where: { deletedAt: null, id: { in: ids }, OR: [{ userId: hubUserId }, { id: { in: membre.map((m) => m.tenantId) } }] }, select: { id: true, name: true, slug: true, userId: true } });
  const res: Fermee[] = [];
  for (const o of orgs) {
    const i = await db.tenantIdp.findUnique({ where: { tenantId: o.id }, select: { id: true, issuer: true, alias: true, actif: true, sessionJours: true } });
    // Le lien (fournisseur, sub) vaut pour CE fournisseur : un autre repart d'un identifiant neuf, les anciennes preuves ne valent plus rien.
    const relie = i ? (await db.account.findFirst({ where: { provider: `org:${i.id}`, user: { supabaseUserId: hubUserId } }, select: { id: true } })) !== null : false;
    const x = await db.connexionExemption.findUnique({ where: { tenantId_hubUserId: { tenantId: o.id, hubUserId } }, select: { nature: true, leveLe: true } });
    if (x && !x.leveLe && (x.nature === 'secours' || (x.nature === 'rattachement' && !relie))) continue;
    if (i?.actif && relie && (await prouvee(db, o.id, i, hubUserId, preuve, now))) continue;
    const nom = await db.organisation.findUnique({ where: { tenantId: o.id }, select: { nomAffiche: true } });
    res.push({ tenantId: o.id, nom: nom?.nomAffiche ?? o.name, fournisseur: i ? nomFournisseur(i.issuer) : 'son fournisseur', porte: i?.alias ?? o.slug, proprietaire: o.userId === hubUserId });
  }
  return res;
}

async function prouvee(db: DbObligation, tenantId: string, i: { id: string; sessionJours: number | null }, hubUserId: string, preuve: Preuve, now: number): Promise<boolean> {
  if (preuve.par === 'session') {
    // La session qu'il a ouverte : sa durée et sa borne sont relues à chaque lecture (lib/federation/borne.ts).
    if (preuve.federeOrg === tenantId) return true;
    const p = preuve.preuves?.[tenantId];
    return Boolean(p) && p!.i === i.id && !federationExpiree({ federe: true, authAt: p!.le, federeVu: p!.vu }, Math.floor(now / 1000), joursValables(i.sessionJours));
  }
  if (preuve.par === 'jeton' && !preuve.orgs.includes(tenantId)) return false;
  const p = await db.connexionPreuve.findUnique({ where: { tenantId_hubUserId: { tenantId, hubUserId } }, select: { idpId: true, le: true } });
  return Boolean(p) && p!.idpId === i.id && now - p!.le.getTime() <= SESSION_FEDEREE_MAX_S * 1000;
}

export const estFermee = async (db: DbObligation, hubUserId: string, preuve: Preuve, tenantId: string): Promise<boolean> => (await fermees(db, hubUserId, preuve)).some((f) => f.tenantId === tenantId);

/** Les organisations que cette session a prouvées par leur fournisseur : ce qu'un jeton donné maintenant emporte. */
export async function orgsProuvees(db: Pick<PrismaClient, 'tenantIdp'>, preuve: Preuve, now = Date.now()): Promise<string[]> {
  if (preuve.par !== 'session') return [];
  const res: string[] = [];
  for (const [tenantId, p] of Object.entries(preuve.preuves ?? {})) {
    const i = await db.tenantIdp.findUnique({ where: { tenantId }, select: { id: true, actif: true, sessionJours: true } });
    if (i?.actif && i.id === p.i && !federationExpiree({ federe: true, authAt: p.le, federeVu: p.vu }, Math.floor(now / 1000), joursValables(i.sessionJours))) res.push(tenantId);
  }
  return res;
}

/** Elle vient de passer par le fournisseur de son organisation. L'accès gardé « jusqu'au rattachement » tombe ici, pour de bon. */
export async function noterPassage(db: Pick<PrismaClient, 'connexionPreuve' | 'connexionExemption' | 'auditLog'>, i: { id: string; tenantId: string }, hubUserId: string, now = new Date()): Promise<void> {
  const cle = { tenantId_hubUserId: { tenantId: i.tenantId, hubUserId } };
  await db.connexionPreuve.upsert({ where: cle, create: { tenantId: i.tenantId, hubUserId, idpId: i.id, le: now }, update: { idpId: i.id, le: now } });
  const { count } = await db.connexionExemption.updateMany({ where: { tenantId: i.tenantId, hubUserId, nature: 'rattachement', leveLe: null }, data: { leveLe: now, leveMotif: 'rattachee' } });
  if (count) await writeAuditLog(db as PrismaClient, { action: 'connexion.exemption_tombee', actor: `org:${i.id}`, targetType: 'tenant', targetId: i.tenantId, payload: { hub_user_id: hubUserId, motif: 'rattachee' } });
}

/** Cette app garde-t-elle quelque chose de cette organisation ? Une session d'app suit la PERSONNE, avec tous ses espaces : au moindre doute, oui. */
export async function tientApp(db: Pick<PrismaClient, 'tenant' | 'organisation' | 'tenantApp'>, f: Fermee, app: string): Promise<boolean> {
  if (f.proprietaire) return true;
  const t = await db.tenant.findFirst({ where: { id: f.tenantId }, select: { userId: true, metadata: true, notifuseWorkspaceSlug: true, prospectionProvisionedAt: true } });
  if (!t) return true;
  const cles = app === 'crm' || app === 'twenty' ? ['crm', 'twenty'] : [app];
  const o = await db.organisation.findUnique({ where: { tenantId: f.tenantId }, select: { modules: true } });
  if (o?.modules.some((m) => cles.includes(m))) return true;
  if (app === 'notifuse' && t.notifuseWorkspaceSlug) return true;
  if (app === 'prospection' && t.prospectionProvisionedAt) return true;
  const meta = (t.metadata ?? {}) as Record<string, unknown>;
  if (cles.some((k) => meta[k] !== undefined && meta[k] !== null)) return true;
  return (await db.tenantApp.findFirst({ where: { userId: t.userId, appKey: { in: cles }, enabled: true }, select: { appKey: true } })) !== null;
}
