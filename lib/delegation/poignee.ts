/**
 * Poignée de délégation : remise par le Hub à une app, au rebond, pour UN utilisateur dans UNE organisation. Opaque (256 bits), le
 * Hub n'en garde que l'empreinte. Elle ne donne rien seule : elle s'échange contre un jeton de 120 s, revérifié à chaque fois.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { organisationDeTest } from './ouverture';
import { pairesServies } from './paires';

const JOURS = 30;
/** Poignées vivantes par (utilisateur, app, organisation) : un navigateur de plus ne coupe pas les autres, dix de trop si. */
const VIVANTES_MAX = 10;
export type Poignee = { hub_tenant_id: string; grant: string; expire_le: string };
type Db = Pick<PrismaClient, 'delegationGrant' | 'tenant' | 'tenantMember' | 'user'>;

export const empreinte = (secret: string): string => createHash('sha256').update(secret).digest('hex');

/** Les poignées de ce compte pour cette app, une par organisation vivante. Aucune si l'app n'est la source d'aucune paire servie. */
export async function emettrePoignees(db: Db, d: { hubUserId: string; app: string }, env: NodeJS.ProcessEnv = process.env): Promise<Poignee[]> {
  const source = (test: boolean) => pairesServies(env, test).some((p) => p.source === d.app);
  if (!source(true)) return [];
  const membres = await db.tenantMember.findMany({ where: { userId: d.hubUserId, deletedAt: null }, select: { tenantId: true } });
  const tenants = await db.tenant.findMany({ where: { deletedAt: null, status: { notIn: ['suspended', 'deleted'] }, OR: [{ userId: d.hubUserId }, { id: { in: membres.map((m) => m.tenantId) } }] }, select: { id: true } });
  const expireLe = new Date(Date.now() + JOURS * 86_400_000);
  const res: Poignee[] = [];
  for (const t of tenants) {
    if (!source(await organisationDeTest(db, t.id, env))) continue;
    const grant = randomBytes(32).toString('base64url');
    const cle = { hubUserId: d.hubUserId, app: d.app, tenantId: t.id };
    await db.delegationGrant.create({ data: { ...cle, empreinte: empreinte(grant), expireLe } });
    const vivantes = await db.delegationGrant.findMany({ where: { ...cle, revoqueLe: null, expireLe: { gt: new Date() } }, orderBy: { creeLe: 'desc' }, select: { id: true } });
    const vieilles = vivantes.slice(VIVANTES_MAX).map((v) => v.id);
    if (vieilles.length) await db.delegationGrant.updateMany({ where: { id: { in: vieilles } }, data: { revoqueLe: new Date() } });
    res.push({ hub_tenant_id: t.id, grant, expire_le: expireLe.toISOString() });
  }
  return res;
}

/** Révoque : un membre retiré (dans ce tenant), un compte qui se déconnecte partout (tous), une organisation suspendue. */
export async function revoquerPoignees(db: Pick<PrismaClient, 'delegationGrant'>, d: { hubUserId?: string; tenantId?: string }): Promise<number> {
  if (!d.hubUserId && !d.tenantId) return 0;
  const r = await db.delegationGrant.updateMany({ where: { ...(d.hubUserId ? { hubUserId: d.hubUserId } : {}), ...(d.tenantId ? { tenantId: d.tenantId } : {}), revoqueLe: null }, data: { revoqueLe: new Date() } });
  return r.count;
}
