/**
 * Appel de l'outil CRM `app_reponse_humaine` pour une réponse reçue par Notifuse. Le sujet du jeton est l'INTÉGRATION
 * (`integration:<tenant>`), pas une personne : le CRM l'affiche comme auteur. `tools/call` direct, sans `initialize` : un échec lève,
 * et l'appelant répond 5xx pour que la source réessaie. Le CRM doit avoir répondu pour que ce soit un succès.
 */
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { TTL_ACTION_S } from '@/lib/delegation/jeton';
import { adresseAction, CLE_MCP } from '@/lib/delegation/paires';
import { SessionApp } from '@/lib/mcp/client-app';
import { signerAction } from '@/lib/mcp/identite';

import type { Reponse } from './filtre';

export const OUTIL_CRM = 'app_reponse_humaine';
export const PORTEE_CRM = 'crm:tache.ecrire';

export type IssueCrm = { jti: string; effet: 'cree' | 'rejoue' | 'aucun'; raison?: string };

/** Le premier objet qui porte `ok`, où qu'il soit (texte JSON, `structuredContent`, enveloppe `{success, result}`) ; `success: false` l'emporte. */
function lire(v: unknown, p = 0): Record<string, unknown> | 'refus' | null {
  if (p > 6) return null;
  if (typeof v === 'string') {
    if (!/^\s*[[{]/.test(v)) return null;
    try { return lire(JSON.parse(v), p + 1); } catch { return /"success"\s*:\s*false/.test(v) ? 'refus' : null; }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.success === false || o.ok === false) return 'refus';
  if (o.ok === true) return o;
  let trouve: Record<string, unknown> | null = null;
  for (const x of Object.values(o)) {
    const r = lire(x, p + 1);
    if (r === 'refus') return r;
    trouve ??= r;
  }
  return trouve;
}

export async function ecrireReponseHumaine(db: Pick<PrismaClient, 'mcpApp'>, d: { tenantId: string; reponse: Reponse; chaine: readonly string[] }, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<IssueCrm> {
  const cible = await db.mcpApp.findUnique({ where: { appKey: CLE_MCP.crm }, select: { mcpUrl: true, enabled: true } });
  if (!cible?.enabled) throw new Error('target_not_registered');
  const url = adresseAction('crm', cible.mcpUrl);
  const jti = randomUUID();
  const jeton = await signerAction({ audience: url, hubUserId: `integration:${d.tenantId}`, tenantId: d.tenantId, app: 'notifuse', scope: PORTEE_CRM, jti, ttlS: TTL_ACTION_S }, env);
  const r = d.reponse;
  // `thread_id` est exigé par le CRM : sans fil, le message fait son propre fil, plutôt que de perdre une vraie réponse.
  // Un signal, pas une donnée : identifiants seulement. Ni objet, ni corps, ni expéditeur ; le CRM relit chez Notifuse.
  const args = { email: r.email, workspace_id: r.workspaceId, thread_id: r.threadId ?? r.messageId, message_id: r.messageId, rfc_message_id: r.rfcMessageId, survenu_le: r.survenuLe, idempotency_key: r.evenementId, chaine: [...d.chaine, `notifuse>crm:${r.evenementId}`] };
  const res = (await new SessionApp(url, jeton, fetchImpl, { entetes: { 'Idempotency-Key': r.evenementId } }).appeler(OUTIL_CRM, args)) as { isError?: boolean } | null | undefined;
  // Le succès se lit (`ok: true`), il ne se déduit pas d'une absence d'erreur : le CRM refuse aussi en 200, `success: false` dans le texte (24/11).
  const o = res && typeof res === 'object' && !res.isError ? lire(res) : null;
  if (!o || o === 'refus') throw new Error('crm_refus');
  if (o.ignore === true) return { jti, effet: 'aucun', raison: typeof o.raison === 'string' ? o.raison.replace(/[^\w -]/g, '').slice(0, 60) : 'ignore' };
  return { jti, effet: o.rejoue === true ? 'rejoue' : 'cree' };
}
