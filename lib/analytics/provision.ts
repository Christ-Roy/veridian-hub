/**
 * Ouvrir Analytics à une organisation dès son provisionnement (parente, 26/11, défaut remonté par Analytics) : un nouveau client ne
 * pouvait pas entrer tant qu'on ne lui avait pas créé un site, et le Hub ne voyait pas une organisation Analytics sans site.
 *
 * Contrat (CONTRAT-HUB §5, ligne Analytics) : `POST <analytics>/api/tenants/provision`, signé par le Hub (lib/hmac/signature-hub.ts),
 * corps `{ hub_user_id, email, name, hub_tenant_id, organization_name }`. Analytics crée (ou retrouve) la personne PAR SON hub_user_id,
 * jamais par l'adresse, et l'organisation dont elle est propriétaire, reliée à `hub_tenant_id` ; idempotent ; 200 `{ organization_id }`.
 * Tant que la route n'existe pas chez Analytics (404 sans corps JSON), l'ouverture reste « attente », nommée, sans rien inventer.
 * L'identifiant rendu est noté `metadata.analytics.workspace_id`, que tout le Hub lit (lib/apps/espace-note.ts).
 */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { entetesSignature } from '@/lib/hmac/signature-hub';

export type IssueProvisionAnalytics = { ok: true; organizationId: string } | { ok: false; attente?: string; error?: string };

const Reponse = z.object({ organization_id: z.union([z.string().min(1).max(128), z.number().int()]) });
type Db = Pick<PrismaClient, 'tenant'>;

export async function provisionnerAnalytics(
  db: Db,
  qui: { hubUserId: string; email: string; name: string | null },
  tenantId: string,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<IssueProvisionAnalytics> {
  const env = deps.env ?? process.env;
  const c = resolveAppConfig('analytics', env);
  if (!c) return { ok: false, error: 'analytics_not_configured' };
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { name: true, metadata: true } });
  if (!t) return { ok: false, error: 'tenant_introuvable' };
  const body = JSON.stringify({ hub_user_id: qui.hubUserId, email: qui.email, name: qui.name ?? qui.email.split('@')[0], hub_tenant_id: tenantId, organization_name: t.name });
  const cible = `${c.apiUrl}/api/tenants/provision`;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(cible, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...entetesSignature({ secret: c.hubSecret, methode: 'POST', url: cible, corps: body, app: 'analytics', env }) },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `analytics_injoignable: ${err instanceof Error ? err.message.slice(0, 80) : 'erreur'}` };
  }
  const brut = await res.text().catch(() => '');
  let json: unknown = null;
  try { json = JSON.parse(brut); } catch { /* corps non JSON */ }
  // Route absente : Analytics ne sait pas encore créer depuis le Hub. Ce n'est pas un échec de l'ouverture, c'est un geste qui manque.
  // Fastify rend aussi une route inconnue en JSON (`{"message":"Route POST:/api/tenants/provision not found","error":"Not Found"}`) : mesuré
  // en prod le 26/11, où ce 404 passait pour un refus.
  const j = (json ?? {}) as { message?: unknown; error?: unknown };
  const routeAbsente = res.status === 404 && (!json || (typeof j.message === 'string' && /^Route .* not found$/i.test(j.message)) || j.error === 'Not Found');
  if (routeAbsente) return { ok: false, attente: 'Analytics ne crée pas encore les comptes depuis le Hub (route provision absente)' };
  if (!res.ok) return { ok: false, error: `analytics_${res.status}${(json as { error?: string } | null)?.error ? `_${(json as { error: string }).error}` : ''}` };
  const r = Reponse.safeParse(json);
  if (!r.success) return { ok: false, error: 'analytics_reponse_illisible' };
  const organizationId = String(r.data.organization_id);
  const meta = (t.metadata && typeof t.metadata === 'object' && !Array.isArray(t.metadata) ? t.metadata : {}) as Record<string, unknown>;
  const avant = (meta.analytics && typeof meta.analytics === 'object' ? meta.analytics : {}) as Record<string, unknown>;
  await db.tenant.update({ where: { id: tenantId }, data: { metadata: { ...meta, analytics: { ...avant, workspace_id: organizationId, provisioning_source: 'hub-provision', linked_at: new Date().toISOString() } } as never }, select: { id: true } });
  return { ok: true, organizationId };
}
