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

/** Le CRM refuse aussi en 200 sans drapeau : `{"success":false,…}` dans le texte (mesuré le 24/11). Pris pour un succès, la réponse serait perdue. */
function refuseEnTexte(res: object): boolean {
  const c = (res as { content?: unknown }).content;
  return Array.isArray(c) && c.some((x) => typeof (x as { text?: unknown })?.text === 'string' && /^\s*\{[\s\S]*"success"\s*:\s*false/.test((x as { text: string }).text));
}

export async function ecrireReponseHumaine(db: Pick<PrismaClient, 'mcpApp'>, d: { tenantId: string; reponse: Reponse; chaine: readonly string[] }, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ jti: string }> {
  const cible = await db.mcpApp.findUnique({ where: { appKey: CLE_MCP.crm }, select: { mcpUrl: true, enabled: true } });
  if (!cible?.enabled) throw new Error('target_not_registered');
  const url = adresseAction('crm', cible.mcpUrl);
  const jti = randomUUID();
  const jeton = await signerAction({ audience: url, hubUserId: `integration:${d.tenantId}`, tenantId: d.tenantId, app: 'notifuse', scope: PORTEE_CRM, jti, ttlS: TTL_ACTION_S }, env);
  const r = d.reponse;
  // Un signal, pas une donnée : identifiants seulement. Ni objet, ni corps, ni expéditeur ; le CRM relit chez Notifuse.
  const args = { email: r.email, workspace_id: r.workspaceId, thread_id: r.threadId, message_id: r.messageId, rfc_message_id: r.rfcMessageId, survenu_le: r.survenuLe, idempotency_key: r.evenementId, chaine: [...d.chaine, `notifuse>crm:${r.evenementId}`] };
  const res = (await new SessionApp(url, jeton, fetchImpl, { entetes: { 'Idempotency-Key': r.evenementId } }).appeler(OUTIL_CRM, args)) as { isError?: boolean } | null | undefined;
  if (!res || typeof res !== 'object' || res.isError || refuseEnTexte(res)) throw new Error('crm_refus');
  return { jti };
}
