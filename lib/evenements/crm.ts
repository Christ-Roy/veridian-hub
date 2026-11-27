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
  // Un signal, pas une donnée : identifiants seulement, plus le nom affiché de l'expéditeur quand Mail le donne (VER-247, 26/11 : sans lui
  // la fiche créée restait sans prénom ni nom). Ni objet, ni corps ; le CRM relit chez Notifuse.
  // `kind` et `match_type` : déjà vérifiés ici (réponse humaine rattachée à un envoi) ; le CRM les relit pour créer la fiche d'un expéditeur
  // absent (27/11 : « Camille Épreuve-Autre » non créée, le Hub les vérifiait sans les transmettre).
  const args = { ...(r.nom ? { nom: r.nom } : {}), kind: 'reply_human', match_type: r.matchType, email: r.email, ...(r.contactEmail && r.contactEmail !== r.email ? { contact_email: r.contactEmail } : {}), ...(r.objet ? { subject: r.objet } : {}), workspace_id: r.workspaceId, thread_id: r.threadId ?? r.messageId, message_id: r.messageId, rfc_message_id: r.rfcMessageId, survenu_le: r.survenuLe, idempotency_key: r.evenementId, chaine: [...d.chaine, `notifuse>crm:${r.evenementId}`] };
  const res = (await new SessionApp(url, jeton, fetchImpl, { entetes: { 'Idempotency-Key': r.evenementId } }).appeler(OUTIL_CRM, args)) as { isError?: boolean } | null | undefined;
  // Le succès se lit (`ok: true`), il ne se déduit pas d'une absence d'erreur : le CRM refuse aussi en 200, `success: false` dans le texte (24/11).
  const o = res && typeof res === 'object' && !res.isError ? lire(res) : null;
  if (!o || o === 'refus') throw new Error('crm_refus');
  if (o.ignore === true) return { jti, effet: 'aucun', raison: typeof o.raison === 'string' ? o.raison.replace(/[^\w -]/g, '').slice(0, 60) : 'ignore' };
  return { jti, effet: o.rejoue === true ? 'rejoue' : 'cree' };
}

export const OUTIL_CRM_MAIL = 'app_evenements_mail';
export const PORTEE_CRM_MAIL = 'crm:mail.ecrire';
export type LignesMail = { creees: number; avancees: number; ignorees: number; raisons_ignorees?: Record<string, number> };

/**
 * L'activité Mail d'un lot (§5.25) vers l'outil CRM `app_evenements_mail` : même jeton d'intégration que les réponses, portée
 * `crm:mail.ecrire` (qui n'ouvre rien d'autre). Le CRM range une ligne par message chez une personne existante, jamais ne crée.
 */
export async function ecrireEvenementsMail(db: Pick<PrismaClient, 'mcpApp'>, d: { tenantId: string; workspaceId: string; lotId: string; evenements: Record<string, unknown>[] }, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ jti: string; lignes: LignesMail }> {
  return appelerCrmLignes(db, { tenantId: d.tenantId, app: 'notifuse', portee: PORTEE_CRM_MAIL, outil: OUTIL_CRM_MAIL, lotId: d.lotId, args: { workspace_id: d.workspaceId, evenements: d.evenements } }, env, fetchImpl);
}

export const OUTIL_CRM_VISITE = 'app_evenements_visite';
export const PORTEE_CRM_VISITE = 'crm:visite.ecrire';

/**
 * Les visites d'un lot (§5.26) vers l'outil CRM `app_evenements_visite`, même jeton d'intégration, portée `crm:visite.ecrire` (qui n'ouvre rien
 * d'autre). `kind: 'visite'` : le CRM range une ligne par session chez la personne dont l'adresse est `contact_email`, jamais ne crée.
 */
export async function ecrireVisites(db: Pick<PrismaClient, 'mcpApp'>, d: { tenantId: string; lotId: string; visites: Record<string, unknown>[] }, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ jti: string; lignes: LignesMail }> {
  return appelerCrmLignes(db, { tenantId: d.tenantId, app: 'analytics', portee: PORTEE_CRM_VISITE, outil: OUTIL_CRM_VISITE, lotId: d.lotId, args: { kind: 'visite', visites: d.visites } }, env, fetchImpl);
}

/** Un appel d'outil CRM par lot, signé pour l'intégration de l'organisation ; le CRM doit répondre `ok: true` pour un succès. */
async function appelerCrmLignes(db: Pick<PrismaClient, 'mcpApp'>, d: { tenantId: string; app: string; portee: string; outil: string; lotId: string; args: Record<string, unknown> }, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<{ jti: string; lignes: LignesMail }> {
  const cible = await db.mcpApp.findUnique({ where: { appKey: CLE_MCP.crm }, select: { mcpUrl: true, enabled: true } });
  if (!cible?.enabled) throw new Error('target_not_registered');
  const url = adresseAction('crm', cible.mcpUrl);
  const jti = randomUUID();
  const jeton = await signerAction({ audience: url, hubUserId: `integration:${d.tenantId}`, tenantId: d.tenantId, app: d.app, scope: d.portee, jti, ttlS: TTL_ACTION_S }, env);
  const res = (await new SessionApp(url, jeton, fetchImpl, { entetes: { 'Idempotency-Key': d.lotId } }).appeler(d.outil, d.args)) as { isError?: boolean } | null | undefined;
  const o = res && typeof res === 'object' && !res.isError ? lire(res) : null;
  if (!o || o === 'refus') throw new Error('crm_refus');
  const l = (o.lignes ?? {}) as Partial<Record<keyof LignesMail, unknown>>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  // Liaisons 0.7.5 (27/11) détaille les ignorées : on n'en garde que le décompte par raison (valeurs fermées), jamais l'identifiant du message.
  const raisons = (Array.isArray(o.ignorees) ? o.ignorees : []).reduce<Record<string, number>>((acc, x) => {
    const r = String((x as { raison?: unknown } | null)?.raison ?? 'inconnue').replace(/[^\w-]/g, '').slice(0, 40) || 'inconnue';
    return { ...acc, [r]: (acc[r] ?? 0) + 1 };
  }, {});
  return { jti, lignes: { creees: n(l.creees), avancees: n(l.avancees), ignorees: n(l.ignorees), ...(Object.keys(raisons).length ? { raisons_ignorees: raisons } : {}) } };
}

