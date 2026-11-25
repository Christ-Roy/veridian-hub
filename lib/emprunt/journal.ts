/**
 * Le journal d'un emprunt (VER-263) : qui, quand, chez qui, pourquoi, dans quelles apps, jusqu'à quand. L'ouverture s'écrit AVANT l'emprunt et sans
 * rattrapage : pas de trace, pas d'emprunt. La suite se rattache à cette première ligne par `emprunt`.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { IMPERSONATION_SESSION_TTL_S, PAR_CLE } from '@/lib/auth/emprunt-bornes';

type Db = Pick<PrismaClient, 'auditLog'>;
export type Cible = { id: string; hubUserId: string | null; email: string };
export type Ouverture = { par: string; acteur: string; cible: Cible; raison?: string | null; tenantId?: string | null; app?: string | null; via: 'ecran' | 'lien' };

export const raisonPropre = (r: unknown): string | null => (typeof r === 'string' && r.trim() ? r.replace(/\s+/g, ' ').trim().slice(0, 300) : null);

/** Lève si l'écriture rate. Rend l'identifiant de l'emprunt. */
export async function ouvrirEmprunt(db: Db, o: Ouverture): Promise<string> {
  const l = await db.auditLog.create({
    data: {
      action: 'admin.impersonate.start',
      actor: o.acteur,
      targetType: 'user',
      targetId: o.cible.id,
      payload: { par: o.par, targetEmail: o.cible.email, hubUserId: o.cible.hubUserId, raison: raisonPropre(o.raison), tenantId: o.tenantId ?? null, app: o.app ?? null, via: o.via },
    },
    select: { id: true },
  });
  return l.id;
}

/** Qui a ouvert cet emprunt, d'après le journal. Illisible : `null`, et personne n'entre. */
export async function emprunteurDe(db: Db, empruntId: string): Promise<string | null> {
  const l = await db.auditLog.findUnique({ where: { id: empruntId }, select: { action: true, payload: true } });
  const par = l?.action === 'admin.impersonate.start' ? (l.payload as { par?: unknown } | null)?.par : null;
  return typeof par === 'string' && par ? par : null;
}

export const suiteEmprunt = (db: PrismaClient, s: { action: 'consume' | 'app' | 'end'; empruntId: string; par: string; userId: string; detail?: Record<string, unknown> }) =>
  writeAuditLog(db, { action: `admin.impersonate.${s.action}`, actor: s.par === PAR_CLE ? 'token:ADMIN_SECRET' : `hub_user:${s.par}`, targetType: 'user', targetId: s.userId, payload: { emprunt: s.empruntId, ...s.detail } });

/** Ce que l'app reçoit dans le corps signé du rebond (CONTRAT-HUB §6bis.8.3) : jamais l'adresse de l'emprunteur ni la raison. */
export type EmpruntSigne = { id: string; par: string; expire_le: string };
export function empruntSigne(u: { impersonated?: boolean; impersonatedBy?: string | null; empruntId?: string | null; authAt?: number } | undefined): EmpruntSigne | null {
  if (u?.impersonated !== true || !u.empruntId || !u.impersonatedBy || typeof u.authAt !== 'number') return null;
  return { id: u.empruntId, par: u.impersonatedBy, expire_le: new Date((u.authAt + IMPERSONATION_SESSION_TTL_S) * 1000).toISOString() };
}
