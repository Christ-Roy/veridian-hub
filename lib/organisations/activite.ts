/**
 * « Ce membre a-t-il fait appeler tel outil par son IA, depuis telle date ? » (VER-252). Rendu : fait, premier, dernier, nombre, et rien d'autre
 * (ni arguments, ni résultat, ni les autres outils). Seuls les appels RÉUSSIS attribués à CETTE organisation comptent.
 */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const JOURS_MAX = 400;

/** Ouvert organisation par organisation (`ACTIVITE_ORGANISATIONS`) : lire l'activité d'un client demande l'accord de Robert. Pas de « toutes ». */
export const activiteOuverte = (tenantId: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.ACTIVITE_ORGANISATIONS ?? '').split(',').map((x) => x.trim()).includes(tenantId);

/** Le préfixe nomme son app (`twenty.`, `twenty.create_`) : jamais un préfixe qui ratisse toutes les apps. */
export const DemandeActivite = z.strictObject({
  hub_tenant_id: z.string().uuid(),
  hub_user_id: z.string().uuid(),
  prefixe: z.string().max(80).regex(/^[a-z][a-z0-9-]{1,30}\.[a-z0-9_]{0,48}$/),
  depuis: z.string().datetime({ offset: true }),
});
export type Activite = { fait: boolean; premier: string | null; dernier: string | null; nombre: number };
type Db = Pick<PrismaClient, 'auditLog' | 'tenant' | 'tenantMember'>;

export async function activite(db: Db, d: z.infer<typeof DemandeActivite>, now = Date.now()): Promise<Activite | { refus: 'organisation_introuvable' | 'membre_introuvable' | 'depuis_invalide' }> {
  const depuis = new Date(d.depuis);
  if (depuis.getTime() > now || depuis.getTime() < now - JOURS_MAX * 86_400_000) return { refus: 'depuis_invalide' };
  const t = await db.tenant.findFirst({ where: { id: d.hub_tenant_id, deletedAt: null }, select: { userId: true } });
  if (!t) return { refus: 'organisation_introuvable' };
  const membre = t.userId === d.hub_user_id || (await db.tenantMember.count({ where: { tenantId: d.hub_tenant_id, userId: d.hub_user_id, deletedAt: null } })) > 0;
  if (!membre) return { refus: 'membre_introuvable' };
  const r = await db.auditLog.aggregate({
    where: {
      action: 'mcp.tool.call',
      targetId: d.hub_user_id,
      createdAt: { gte: depuis },
      AND: [
        { payload: { path: ['espace'], equals: d.hub_tenant_id } },
        { payload: { path: ['ok'], equals: true } },
        { payload: { path: ['outil'], string_starts_with: d.prefixe } },
      ],
    },
    _count: true,
    _min: { createdAt: true },
    _max: { createdAt: true },
  });
  return { fait: r._count > 0, premier: r._min.createdAt?.toISOString() ?? null, dernier: r._max.createdAt?.toISOString() ?? null, nombre: r._count };
}
