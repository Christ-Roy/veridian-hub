/** Seul écrivain de `organisations` : valide, écrit, journalise, puis émet. Le même code sert l'écran, la CLI et les imports. */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { writeAuditLog } from '@/lib/admin/audit-log';

import { COULEUR, MODULES, TYPES } from './document';
import { emettreOrganisation, type Emission } from './emission';
import { reencoderLogo } from './logo';

const couleur = z.string().regex(COULEUR).nullable();
export const Reglage = z.object({
  type: z.enum(TYPES).optional(),
  nom_affiche: z.string().trim().min(1).max(80).nullable().optional(),
  couleur_primaire: couleur.optional(),
  couleur_accent: couleur.optional(),
  modules: z.array(z.enum(MODULES)).max(20).optional(),
  reglages: z.record(z.enum(MODULES), z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))).optional(),
}).strict();
export type Reglage = z.infer<typeof Reglage>;

type Db = Pick<PrismaClient, 'organisation' | 'organisationEmission' | 'tenant' | 'tenantMember' | 'user' | 'auditLog'>;
type Deps = Parameters<typeof emettreOrganisation>[2];
export type Issue = { emissions: Emission[] } | { refus: 'tenant_introuvable' | 'trop_gros' | 'format_refuse' };

export async function reglerOrganisation(db: Db, d: { tenantId: string; reglage: Reglage; logo?: Buffer | null; acteur: string }, deps: Deps = {}): Promise<Issue> {
  const t = await db.tenant.findFirst({ where: { id: d.tenantId, deletedAt: null }, select: { id: true } });
  if (!t) return { refus: 'tenant_introuvable' };
  const l = d.logo ? await reencoderLogo(d.logo) : null;
  if (l && 'refus' in l) return l;
  const r = d.reglage;
  const data = {
    ...(r.type !== undefined ? { type: r.type } : {}),
    ...(r.nom_affiche !== undefined ? { nomAffiche: r.nom_affiche } : {}),
    ...(r.couleur_primaire !== undefined ? { couleurPrimaire: r.couleur_primaire } : {}),
    ...(r.couleur_accent !== undefined ? { couleurAccent: r.couleur_accent } : {}),
    ...(r.modules !== undefined ? { modules: Array.from(new Set(r.modules)) } : {}),
    ...(r.reglages !== undefined ? { reglages: r.reglages as never } : {}),
    ...(l ? { logo: new Uint8Array(l.png), logoEmpreinte: l.empreinte } : d.logo === null ? { logo: null, logoEmpreinte: null } : {}),
    majLe: new Date(),
    majPar: d.acteur.slice(0, 200),
  };
  await db.organisation.upsert({ where: { tenantId: d.tenantId }, create: { tenantId: d.tenantId, ...data }, update: data });
  await writeAuditLog(db as PrismaClient, { action: 'organisation.reglee', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { champs: Object.keys(r), logo: l ? l.empreinte : d.logo === null ? 'retire' : undefined } });
  return { emissions: await emettreOrganisation(db, d.tenantId, deps) };
}
