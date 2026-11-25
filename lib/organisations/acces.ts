/**
 * Qui est entré dans une app RÉSERVÉE par l'organisation (parente, 25/11) : cocher l'app fait entrer ses membres, décocher retire ceux-là et eux seuls,
 * recocher les remet. Noté par le Hub à l'émission qui fait entrer. Déjà dans l'espace avant elle, invité à la main, ou dans le doute : « main », gardé.
 */
import type { PrismaClient } from '@prisma/client';

import { discoverAppForEmail } from '@/lib/sync/discovery';

import type { DocumentOrg, MembreOrg, Module } from './document';

/** Les apps réservées qu'une organisation ouvre. Mail et Prospection sont ouvertes à tous : décocher n'y retire personne. */
export const RESERVEES: readonly Module[] = ['crm', 'academy'];
const DELAI_MS = 15_000;

export type DbAcces = Pick<PrismaClient, 'organisationAcces'>;
type Deps = { fetchImpl?: typeof fetch };
type Vus = { hubUserId: string; origine: 'organisation' | 'main' }[];

/** Avant d'émettre vers une app réservée : ceux que le Hub n'a pas encore notés, et si l'app les a déjà dans cet espace. Muette : « main ». */
export async function releverAvant(db: DbAcces, d: DocumentOrg, app: Module, proprietaire: string, deps: Deps = {}): Promise<Vus> {
  const notes = new Set((await db.organisationAcces.findMany({ where: { tenantId: d.hub_tenant_id, app }, select: { hubUserId: true } })).map((n) => n.hubUserId));
  const nouveaux = d.membres.filter((m) => m.hub_user_id !== proprietaire && m.role !== 'owner' && !notes.has(m.hub_user_id));
  return Promise.all(nouveaux.map(async (m: MembreOrg) => {
    const r = await discoverAppForEmail(app, m.email, { hubUserId: m.hub_user_id, timeoutMs: DELAI_MS, fetchImpl: deps.fetchImpl });
    const absent = 'found' in r && (!r.found || !r.snapshots.some((s) => s.status !== 'deleted' && s.hubTenantLink === d.hub_tenant_id));
    return { hubUserId: m.hub_user_id, origine: absent ? ('organisation' as const) : ('main' as const) };
  }));
}

/** Après une émission APPLIQUÉE. Une note existante ne bouge pas : la première origine reste, sauf une invitation à la main. */
export async function noterVenus(db: DbAcces, tenantId: string, app: Module, vus: Vus, now = new Date()): Promise<void> {
  if (vus.length) await db.organisationAcces.createMany({ data: vus.map((v) => ({ tenantId, app, hubUserId: v.hubUserId, origine: v.origine, poseLe: now })), skipDuplicates: true });
}

/** Recochée : ceux venus par elle reviennent, même si le retrait n'avait pas été relu. L'app n'accepte qu'une adhésion postérieure au retrait, d'où la date. */
export async function rouvrir(db: DbAcces, tenantId: string, app: Module, now = new Date()): Promise<void> {
  await db.organisationAcces.updateMany({ where: { tenantId, app, origine: 'organisation' }, data: { retireLe: null, rejointLe: now } });
}

/** Le document avec, pour cette app, la date d'adhésion en vigueur : la plus récente de l'adhésion au Hub et de la recoche. */
export async function avecRecoche(db: DbAcces, d: DocumentOrg, app: Module): Promise<DocumentOrg> {
  const l = await db.organisationAcces.findMany({ where: { tenantId: d.hub_tenant_id, app, rejointLe: { not: null } }, select: { hubUserId: true, rejointLe: true } });
  if (l.length === 0) return d;
  const par = new Map(l.map((x) => [x.hubUserId, x.rejointLe!.toISOString()]));
  return { ...d, membres: d.membres.map((m) => { const r = par.get(m.hub_user_id); return r && r > m.joined_at ? { ...m, joined_at: r } : m; }) };
}

/** Invité à la main : décocher ne le retirera plus. */
export async function noterInvite(db: DbAcces, tenantId: string, app: string, hubUserId: string): Promise<void> {
  if (!(RESERVEES as readonly string[]).includes(app)) return;
  await db.organisationAcces.upsert({ where: { tenantId_app_hubUserId: { tenantId, app, hubUserId } }, create: { tenantId, app, hubUserId, origine: 'main' }, update: { origine: 'main', retireLe: null } });
}
