/**
 * F3 : une réponse humaine reçue par Notifuse crée une tâche dans le CRM (INTEGRATIONS-NATIVES §6, D5 : traité PENDANT l'appel de la source).
 * Ordre : signature (secret de l'abonnement) → filtre → organisation et paire → chaîne → disjoncteur → dédoublonnage → CRM. Un 2xx ne part que si
 * le CRM a répondu, ou si rien n'est à faire (et alors le corps dit pourquoi) ; un échec rend 5xx et libère la ligne : la source réessaie.
 * Fermé par défaut : `DELEGATION_EVENEMENTS` (clés de paires, `<paire>@test` pour les organisations de test), indépendant de `DELEGATION_CIBLES`.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { AppDebit } from '@/lib/mcp/client-app';
import { liaisonActive, noterPassage } from '@/lib/delegation/etat';
import { evenementOuvert, paire, porteesAccordees } from '@/lib/delegation/paires';
import { estDeTest } from '@/lib/tenants/marque-test';

import { lireAbonnement } from './abonnement';
import { chaineAcceptable, disjoncteur, noterEcriture, objetDuLien } from './anti-boucle';
import { ecrireReponseHumaine, PORTEE_CRM, type IssueCrm, causeEchecCrm } from './crm';
import { liberer, reserver, terminer, type CleEvenement } from './dedoublonnage';
import { analyserMessageRecu } from './filtre';
import { verifierStandardWebhooks } from './signature';

const SOURCE = 'notifuse';
type Db = Pick<PrismaClient, 'evenementAbonnement' | 'evenementRecu' | 'integrationLien' | 'integrationPause' | 'integrationPaire' | 'organisation' | 'tenant' | 'tenantMember' | 'mcpApp' | 'auditLog'>;
export type Reception = { statut: number; corps: Record<string, unknown>; retryAfterS?: number };
const ack = (raison: string): Reception => ({ statut: 200, corps: { ok: true, effet: 'aucun', raison } });
const refus = (statut: number, error: string, retryAfterS?: number): Reception => ({ statut, corps: { error }, retryAfterS });

export async function recevoirNotifuse(db: Db, h: Headers, brut: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Reception> {
  let json: unknown = null;
  try {
    json = JSON.parse(brut);
  } catch {
    return refus(400, 'invalid_request');
  }
  const ws = (json as { workspace_id?: unknown } | null)?.workspace_id;
  if (typeof ws !== 'string' || !ws || ws.length > 512) return refus(400, 'invalid_request');
  let abo;
  try {
    abo = await lireAbonnement(db, SOURCE, ws, env);
  } catch {
    return refus(503, 'secret_unavailable');
  }
  // Inconnu ou mal signé : même réponse, on ne dit pas quels espaces existent.
  if (!abo) return refus(401, 'invalid_signature');
  const v = verifierStandardWebhooks(abo.secret, h, brut, now);
  if (v !== 'ok') return refus(v === 'invalid_headers' ? 400 : 401, v);

  const a = analyserMessageRecu(json);
  if (a.statut === 'invalide') return refus(400, 'invalid_request');
  if (a.statut === 'ignore') return ack(a.raison);
  const { reponse } = a;

  const p = paire('notifuse>crm');
  const t = await db.tenant.findFirst({ where: { id: abo.tenantId, deletedAt: null }, select: { status: true, metadata: true } });
  if (!p || !t || t.status === 'suspended' || t.status === 'deleted') return ack('organisation_inactive');
  if (!evenementOuvert(p.cle, abo.tenantId, env, estDeTest(t.metadata, new Date(now)))) return ack('evenements_fermes');
  if (!porteesAccordees(p, PORTEE_CRM) || !(await liaisonActive(db, p, abo.tenantId))) return ack('paire_eteinte');

  const chaine: string[] = [];
  if (!chaineAcceptable(chaine, p.cle)) return ack('chaine_refusee');
  const lien = { tenantId: abo.tenantId, paire: p.cle, objetSource: objetDuLien(reponse.email) };
  if ((await disjoncteur(db, lien, now)) === 'pause') return ack('pause_disjoncteur');

  const cle: CleEvenement = { source: SOURCE, evenementId: reponse.evenementId, messageId: reponse.messageId, cleRfc: reponse.rfcMessageId ? `${ws}:${reponse.rfcMessageId}` : null, tenantId: abo.tenantId };
  const r = await reserver(db, cle, now);
  if (r === 'deja') return ack('deja_traite');
  if (r === 'en_cours') return refus(503, 'en_cours', 30);

  let issue: IssueCrm;
  try {
    issue = (await ecrireReponseHumaine(db, { tenantId: abo.tenantId, reponse, chaine }, env, fetchImpl));
  } catch (err) {
    await liberer(db, cle).catch(() => undefined);
    const erreur = causeEchecCrm(err);
    // Une liaison active PAR DÉFAUT n'a pas de ligne : un simple updateMany n'écrivait l'erreur nulle part (recette du 26/11 : cinq échecs sans
    // trace). Ligne `defaut` comme noterPassage, qui garde l'état par défaut ; et l'audit, sans adresse ni contenu.
    await db.integrationPaire.upsert({ where: { tenantId_paire: { tenantId: abo.tenantId, paire: p.cle } }, create: { tenantId: abo.tenantId, paire: p.cle, etat: 'defaut', changePar: 'hub defaut', derniereErreur: erreur }, update: { derniereErreur: erreur } }).catch(() => undefined);
    await writeAuditLog(db as PrismaClient, { action: 'evenement.echec', actor: `app:${SOURCE}`, targetType: 'tenant', targetId: abo.tenantId, payload: { paire: p.cle, evenement_id: reponse.evenementId, erreur } }).catch(() => undefined);
    if (err instanceof AppDebit) return refus(503, 'crm_rate_limited', Math.ceil(err.attenteMs / 1000));
    // L'app du CRM s'installe : passager. Le reste (désinstallée, espace non relié) demande un geste, la source garde son rythme de réessai.
    if (erreur === 'crm_app_installing' || erreur === 'crm_app_install_failed') return refus(503, erreur, 60);
    // 503, jamais 502 : Cloudflare remplace un 502 de l'origine par sa propre page, et la source perdait le code (26/11, « 502 » HTML en prod).
    // Le corps garde `crm_unreachable` pour la vraie panne réseau (ce que Mail lit déjà) ; les autres causes se nomment (causeEchecCrm).
    return refus(503, erreur === 'crm_injoignable' ? 'crm_unreachable' : erreur);
  }
  // Le CRM a répondu : plus rien ci-dessous ne doit rendre un 5xx (la source rejouerait une écriture faite).
  // Le disjoncteur compte les écritures : une réponse que le CRM écarte ou a déjà n'en est pas une.
  if (issue.effet === 'cree') await noterEcriture(db, { ...lien, evenementId: reponse.evenementId }, now).catch(() => undefined);
  await terminer(db, cle, issue.effet === 'aucun' ? 'ignore' : 'fait', issue.raison, now).catch(() => undefined);
  await noterPassage(db, p, abo.tenantId, new Date(now)).catch(() => undefined);
  // Ni adresse ni contenu : l'événement, la paire, le jeton.
  await writeAuditLog(db as PrismaClient, { action: 'evenement.recu', actor: `app:${SOURCE}`, targetType: 'tenant', targetId: abo.tenantId, payload: { paire: p.cle, evenement_id: reponse.evenementId, jti: issue.jti, effet: issue.effet, ...(issue.raison ? { raison: issue.raison } : {}) } }).catch(() => undefined);
  return { statut: 200, corps: { ok: true, effet: issue.effet, ...(issue.raison ? { raison: `crm_${issue.raison}` } : {}) } };
}
