/**
 * Import d'une liste de membres dans une organisation (VER-252). Passe UNIQUEMENT par `rejoindre()` (origine 'operateur') : aucune
 * écriture directe. Ne crée aucun compte, n'envoie aucun mail : une personne sans compte, ou
 * qui n'a pas prouvé son adresse, est PRÉ-INSCRITE et joindra à son premier passage prouvé (lib/tenants/preinscription.ts). Un membre retiré n'est jamais rejoint par un import : seul un geste neuf
 * (`hub membre ajouter`) le fait revenir. Une adresse déjà membre garde son rôle : l'import ne rétrograde personne.
 */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { RefusMembre, rejoindre, type DbMembres, type Role } from '@/lib/tenants/membres';
import { preinscrire } from '@/lib/tenants/preinscription';

import { suivreOrganisation, type Emission } from './emission';

export const LIMITE_IMPORT = 500;
export type EtatLigne = 'joint' | 'deja' | 'preinscrit' | 'retire' | 'refuse';
export type LigneImport = { email: string; role: Role; etat: EtatLigne; detail?: string };
export type ImportMembre = { email: string; role?: string };
type Db = DbMembres & Pick<PrismaClient, 'organisation' | 'organisationEmission' | 'tenantPreinscription'>;
type Deps = Parameters<typeof suivreOrganisation>[2];

const adresse = z.string().email().max(254);
const ROLES_IMPORTABLES: readonly Role[] = ['member', 'admin'];

/** Adresses en minuscules, sans doublon, dans l'ordre reçu. Une ligne au rôle inconnu est gardée, pour être refusée. */
export function normaliser(lignes: ImportMembre[]): { email: string; role: string }[] {
  const vus = new Set<string>();
  const out: { email: string; role: string }[] = [];
  for (const l of lignes) {
    const email = l.email.trim().toLowerCase();
    if (vus.has(email)) continue;
    vus.add(email);
    out.push({ email, role: (l.role ?? 'member').trim().toLowerCase() || 'member' });
  }
  return out;
}

/** Un seul passage : chaque adresse rend son état, puis UNE émission vers les apps cochées. À blanc : rien n'est écrit, rien n'est émis. */
export async function importerMembres(db: Db, d: { tenantId: string; membres: ImportMembre[]; acteur: string; aBlanc?: boolean }, deps: Deps = {}): Promise<{ lignes: LigneImport[]; organisation: Emission[] } | { refus: 'tenant_introuvable' }> {
  const t = await db.tenant.findFirst({ where: { id: d.tenantId, deletedAt: null }, select: { id: true, userId: true } });
  if (!t) return { refus: 'tenant_introuvable' };
  const lignes: LigneImport[] = [];
  for (const l of normaliser(d.membres)) {
    lignes.push(await unMembre(db, { tenantId: t.id, proprietaire: t.userId, ...l, acteur: d.acteur, aBlanc: d.aBlanc === true }));
  }
  const organisation = d.aBlanc ? [] : await suivreOrganisation(db, t.id, deps);
  return { lignes, organisation };
}

async function unMembre(db: Db, d: { tenantId: string; proprietaire: string; email: string; role: string; acteur: string; aBlanc: boolean }): Promise<LigneImport> {
  const base = { email: d.email, role: 'member' as Role };
  if (!adresse.safeParse(d.email).success) return { ...base, etat: 'refuse', detail: 'adresse_invalide' };
  if (!ROLES_IMPORTABLES.includes(d.role as Role)) return { ...base, etat: 'refuse', detail: 'role_refuse' };
  const role = d.role as Role;
  const u = await db.user.findFirst({ where: { email: { equals: d.email, mode: 'insensitive' } }, select: { supabaseUserId: true, emailVerified: true } });
  const attendre = async (): Promise<LigneImport> => {
    const detail = role === 'member' ? undefined : 'membre d\'abord : un rôle plus haut se pose après la jonction';
    if (d.aBlanc) return { ...base, etat: 'preinscrit', detail: detail ?? 'à blanc' };
    const fin = await preinscrire(db, { tenantId: d.tenantId, email: d.email, acteur: d.acteur });
    return { ...base, etat: 'preinscrit', detail: detail ?? `jusqu'au ${fin.toISOString().slice(0, 10)}` };
  };
  if (!u?.supabaseUserId) return attendre();
  if (u.supabaseUserId === d.proprietaire) return { ...base, role, etat: 'deja', detail: 'owner' };
  const ligne = await db.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: d.tenantId, userId: u.supabaseUserId } } });
  if (ligne?.deletedAt) return { ...base, role, etat: 'retire' };
  if (ligne) return { ...base, role: ligne.role as Role, etat: 'deja', detail: `rôle ${ligne.role} conservé` };
  if (!u.emailVerified) return attendre();
  if (d.aBlanc) return { ...base, role, etat: 'joint', detail: 'à blanc' };
  try {
    const r = await rejoindre(db, { tenantId: d.tenantId, hubUserId: u.supabaseUserId, role, origine: 'operateur', acteur: d.acteur });
    return { ...base, role: r.role as Role, etat: r.cree ? 'joint' : 'deja' };
  } catch (err) {
    if (!(err instanceof RefusMembre)) throw err;
    if (err.code === 'compte_introuvable' || err.code === 'adresse_non_prouvee') return attendre();
    if (err.code === 'retire') return { ...base, role, etat: 'retire' };
    return { ...base, role, etat: 'refuse', detail: err.code };
  }
}
