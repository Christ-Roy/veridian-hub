/**
 * Échange d'une poignée contre un jeton d'action (VER-245 b.2, INTEGRATIONS-NATIVES §2.2). Le tenant vient de la poignée, jamais de
 * l'app. Tout est revérifié à chaque échange, dans l'ordre : paire et portées, poignée, appartenance, organisation, interrupteur.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { readAppSecrets } from '@/lib/sync/discovery';
import type { SyncApp } from '@/lib/sync/types';
import { signerAction } from '@/lib/mcp/identite';

import { listerIntegrations } from './interrupteur';
import { organisationDeTest } from './ouverture';
import { adresseAction, CLE_MCP, paireServie, empreintePortees, paireEntre, porteesAccordees, type AppPaire } from './paires';
import { empreinte } from './poignee';

export const FENETRE_MS = 5 * 60_000;
export const TTL_ACTION_S = 120;
const PAR_MINUTE = 60;
const APPS: readonly AppPaire[] = ['prospection', 'notifuse', 'crm'];

export type Refus = { statut: number; error: string; retryAfterS?: number };
export type Db = Pick<PrismaClient, 'delegationGrant' | 'delegationNonce' | 'tenant' | 'tenantMember' | 'user' | 'integrationPaire' | 'mcpApp' | 'tenantApp' | 'auditLog'>;

/** Signature de l'app : HMAC-SHA256 du secret de l'app sur `ts.nonce.corps`, fenêtre de 5 min, nonce à usage unique. */
export async function verifierAppel<A extends SyncApp = AppPaire>(db: Pick<PrismaClient, 'delegationNonce'>, h: Headers, corps: string, now = Date.now(), apps: readonly A[] = APPS as unknown as readonly A[]): Promise<{ app: A } | Refus> {
  const app = h.get('x-veridian-app') as A | null;
  const ts = h.get('x-veridian-timestamp') ?? '';
  const nonce = h.get('x-veridian-nonce') ?? '';
  const sig = h.get('x-veridian-hub-signature') ?? '';
  if (!app || !apps.includes(app) || !/^\d{13}$/.test(ts) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { statut: 400, error: 'invalid_headers' };
  const secrets = readAppSecrets(app);
  if (secrets.length === 0) return { statut: 503, error: 'app_not_configured' };
  if (Math.abs(now - Number(ts)) > FENETRE_MS) return { statut: 401, error: 'timestamp_expired' };
  // Tous comparés, sans sortir au premier : le temps ne dit pas lequel a validé.
  const recu = Buffer.from(sig, 'hex');
  const valides = secrets.map((s) => timingSafeEqual(createHmac('sha256', s).update(`${ts}.${nonce}.${corps}`).digest(), recu));
  if (!valides.includes(true)) return { statut: 401, error: 'invalid_signature' };
  try {
    await db.delegationNonce.create({ data: { empreinte: empreinte(`${app}.${nonce}`), expireLe: new Date(now + 2 * FENETRE_MS) } });
  } catch {
    return { statut: 401, error: 'nonce_replayed' };
  }
  await db.delegationNonce.deleteMany({ where: { expireLe: { lt: new Date(now) } } }).catch(() => undefined);
  return { app };
}

const fenetres = new Map<string, number[]>();
export const oublierDebit = () => fenetres.clear();
export function deborde(cle: string, now: number, max = PAR_MINUTE): boolean {
  const l = (fenetres.get(cle) ?? []).filter((t) => t > now - 60_000);
  l.push(now);
  fenetres.set(cle, l);
  if (fenetres.size > 5_000) fenetres.clear();
  return l.length > max;
}

export type Demande = { subject_grant: string; audience: string; scope: string; motif?: string };

export async function echanger(db: Db, app: AppPaire, d: Demande, env: NodeJS.ProcessEnv = process.env): Promise<{ jeton: string; tenantId: string; expiresIn: number; url: string } | Refus> {
  const p = paireEntre(app, d.audience);
  const portees = p ? porteesAccordees(p, d.scope) : null;
  if (!p || !portees) return { statut: 403, error: 'pair_not_allowed' };
  if (!paireServie(p, env, true)) return { statut: 403, error: 'target_not_served' };

  const g = await db.delegationGrant.findUnique({ where: { empreinte: empreinte(d.subject_grant) } });
  if (!g || g.app !== app || g.revoqueLe || g.expireLe <= new Date()) return { statut: 403, error: 'grant_invalid' };
  const refuser = async (error: string): Promise<Refus> => {
    await db.integrationPaire.updateMany({ where: { tenantId: g.tenantId, paire: p.cle }, data: { derniereErreur: error } }).catch(() => undefined);
    await writeAuditLog(db as PrismaClient, { action: 'delegation.refus', actor: `app:${app}`, targetType: 'tenant', targetId: g.tenantId, payload: { hub_user_id: g.hubUserId, paire: p.cle, error } });
    return { statut: 403, error };
  };

  const u = await db.user.findFirst({ where: { supabaseUserId: g.hubUserId }, select: { email: true, emailVerified: true } });
  if (!u?.emailVerified) return refuser('user_invalid');
  const t = await db.tenant.findFirst({ where: { id: g.tenantId, deletedAt: null }, select: { userId: true, status: true } });
  if (!t) return refuser('tenant_not_found');
  if (!paireServie(p, env, await organisationDeTest(db, g.tenantId, env))) return refuser('target_not_served');
  if (t.userId !== g.hubUserId) {
    const m = await db.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: g.tenantId, userId: g.hubUserId } } });
    if (!m || m.deletedAt) return refuser('not_member');
  }
  if (t.status === 'suspended' || t.status === 'deleted') return refuser('tenant_suspended');
  const i = await db.integrationPaire.findUnique({ where: { tenantId_paire: { tenantId: g.tenantId, paire: p.cle } } });
  if (!i || i.etat !== 'allumee' || !i.consentiLe || i.portees !== empreintePortees(p)) return refuser('integration_off');
  if (deborde(`${app}:${g.tenantId}`, Date.now())) return { statut: 429, error: 'rate_limited', retryAfterS: 60 };

  const cibleMcp = await db.mcpApp.findUnique({ where: { appKey: CLE_MCP[p.cible] }, select: { mcpUrl: true, enabled: true, acces: true } });
  if (!cibleMcp?.enabled) return { statut: 503, error: 'target_not_registered' };
  // Une app réservée, que l'utilisateur n'a pas : la délégation ne l'y fait pas entrer.
  if (cibleMcp.acces !== 'tous' && !(await db.tenantApp.findFirst({ where: { userId: g.hubUserId, appKey: CLE_MCP[p.cible], enabled: true }, select: { appKey: true } }))) return refuser('app_not_open');
  const url = adresseAction(p.cible, cibleMcp.mcpUrl);
  const jti = randomUUID();
  const jeton = await signerAction({ audience: url, hubUserId: g.hubUserId, email: u.email, tenantId: g.tenantId, app, scope: portees, jti, ttlS: TTL_ACTION_S }, env);
  await db.integrationPaire.updateMany({ where: { tenantId: g.tenantId, paire: p.cle }, data: { dernierPassage: new Date(), derniereErreur: null } }).catch(() => undefined);
  // Ni données ni poignée : qui, quelle paire, quel jeton, pourquoi.
  await writeAuditLog(db as PrismaClient, { action: 'delegation.jeton', actor: `app:${app}`, targetType: 'tenant', targetId: g.tenantId, payload: { hub_user_id: g.hubUserId, paire: p.cle, scope: portees, jti, motif: (d.motif ?? '').slice(0, 80) } });
  return { jeton, tenantId: g.tenantId, expiresIn: TTL_ACTION_S, url };
}

/** L'état des liaisons dont cette app est la source, dans l'organisation de la poignée : de quoi ne pas montrer un bouton qui refusera. */
export async function etatDesPaires(db: Db, app: AppPaire, grant: string, env: NodeJS.ProcessEnv = process.env): Promise<{ tenantId: string; paires: { audience: string; etat: string; portees: readonly string[] }[] } | Refus> {
  const g = await db.delegationGrant.findUnique({ where: { empreinte: empreinte(grant) } });
  if (!g || g.app !== app || g.revoqueLe || g.expireLe <= new Date()) return { statut: 403, error: 'grant_invalid' };
  const l = await listerIntegrations(db, g.tenantId, env);
  return { tenantId: g.tenantId, paires: l.filter((x) => x.source === app).map((x) => ({ audience: x.cible, etat: x.etat, portees: paireEntre(app, x.cible)!.portees })) };
}
