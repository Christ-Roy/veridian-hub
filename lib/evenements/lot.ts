/**
 * Activité Mail par lots vers le CRM (CONTRAT-HUB §5.25, Robert 26/11, validé par Mail le 26/11).
 * Ordre : signature (secret de l'abonnement de l'espace, Standard Webhooks, webhook-id = lot_id) → forme du lot → organisation et paire
 * → dédoublonnage du lot → tri des événements → outil CRM `app_evenements_mail` (portée `crm:mail.ecrire`).
 * Jamais de corps ; sujet tronqué à 200 ; un clic n'a que l'hôte ; l'adresse du destinataire n'est jamais journalisée. Le CRM ne range que
 * chez une personne existante (une campagne ne crée jamais de fiche) ; une réponse humaine reste au canal `message.received`.
 */
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { liaisonActive, noterPassage } from '@/lib/delegation/etat';
import { evenementOuvert, paire, porteesAccordees } from '@/lib/delegation/paires';
import { AppDebit } from '@/lib/mcp/client-app';
import { estDeTest } from '@/lib/tenants/marque-test';

import { lireAbonnement } from './abonnement';
import { ecrireEvenementsMail, PORTEE_CRM_MAIL, causeEchecCrm } from './crm';
import { liberer, reserver, terminer, type CleEvenement } from './dedoublonnage';
import { nomAffiche, normaliserRfc } from './filtre';
import { verifierStandardWebhooks } from './signature';

const SOURCE = 'notifuse';
const SOURCE_LOT = 'notifuse-lot';
export const LOT_MAX_EVENEMENTS = 200;
export const LOT_MAX_OCTETS = 1_000_000;
const PASSE_MAX_MS = 7 * 86_400_000;
const FUTUR_MAX_MS = 5 * 60_000;

type Db = Pick<PrismaClient, 'evenementAbonnement' | 'evenementRecu' | 'integrationPaire' | 'organisation' | 'tenant' | 'tenantMember' | 'mcpApp' | 'auditLog'>;
export type ReceptionLot = { statut: number; corps: Record<string, unknown>; retryAfterS?: number };
const refus = (statut: number, error: string, retryAfterS?: number): ReceptionLot => ({ statut, corps: { error }, retryAfterS });

const Lot = z.object({
  workspace_id: z.string().min(1).max(512),
  lot_id: z.string().uuid(),
  hub_tenant_id: z.string().uuid().optional(),
  evenements: z.array(z.unknown()),
});
const Texte = (max: number) => z.string().max(max).nullish();
const Evenement = z.object({
  event: z.enum(['message.sent', 'message.delivered', 'message.opened', 'message.clicked', 'message.bounced', 'message.unsubscribed', 'message.received']),
  occurred_at: z.string().min(1).max(40),
  rfc_message_id: z.string().min(1).max(998),
  thread_id: Texte(128),
  recipient_email: z.string().max(254),
  from_email: Texte(254),
  from_name: Texte(400),
  subject: Texte(4000),
  nature: z.enum(['campaign', 'sequence', 'transactional', 'reply_human', 'reply_auto', 'bounce']),
  list_id: Texte(128),
  automation_id: Texte(128),
  broadcast_id: Texte(128),
  bounce_type: z.enum(['hard', 'soft']).nullish(),
  host: Texte(253),
});

/** Ce que le Hub garde d'un événement : jamais d'URL (l'hôte seul), sujet tronqué, adresses normalisées. null : ignoré, avec sa raison. */
export function trierEvenement(brut: unknown, now: number): { ok: Record<string, unknown> } | { raison: string } {
  const p = Evenement.safeParse(brut);
  if (!p.success) return { raison: 'invalide' };
  const e = p.data;
  const t = Date.parse(e.occurred_at);
  if (!Number.isFinite(t)) return { raison: 'date_invalide' };
  if (t < now - PASSE_MAX_MS) return { raison: 'trop_ancien' };
  if (t > now + FUTUR_MAX_MS) return { raison: 'futur' };
  const destinataire = e.recipient_email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinataire)) return { raison: 'destinataire_invalide' };
  // Un hôte, jamais un chemin ni des paramètres (ils portent des jetons) : ce qui n'est pas un nom d'hôte est retiré.
  const hote = e.host && /^[a-z0-9.-]+$/i.test(e.host.trim()) ? e.host.trim().toLowerCase() : null;
  return {
    ok: {
      event: e.event,
      occurred_at: new Date(t).toISOString(),
      rfc_message_id: normaliserRfc(e.rfc_message_id) ?? e.rfc_message_id.trim().toLowerCase(),
      thread_id: e.thread_id ?? null,
      recipient_email: destinataire,
      from_email: e.from_email?.trim().toLowerCase() || null,
      from_name: nomAffiche(e.from_name),
      subject: e.subject ? e.subject.slice(0, 200) : null,
      nature: e.nature,
      list_id: e.list_id ?? null,
      automation_id: e.automation_id ?? null,
      broadcast_id: e.broadcast_id ?? null,
      bounce_type: e.bounce_type ?? null,
      host: e.event === 'message.clicked' ? hote : null,
    },
  };
}

export async function recevoirLot(db: Db, h: Headers, brut: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<ReceptionLot> {
  if (Buffer.byteLength(brut) > LOT_MAX_OCTETS) return refus(413, 'too_large');
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
    return refus(503, 'secret_unavailable', 30);
  }
  // Inconnu ou mal signé : même réponse, on ne dit pas quels espaces existent.
  if (!abo) return refus(401, 'invalid_signature');
  const v = verifierStandardWebhooks(abo.secret, h, brut, now);
  if (v !== 'ok') return refus(v === 'invalid_headers' ? 400 : 401, v);

  const p0 = Lot.safeParse(json);
  if (!p0.success) return refus(400, 'invalid_request');
  const lot = p0.data;
  // Le rejeu se reconnaît au lot : l'identifiant signé doit être celui du corps.
  if (h.get('webhook-id') !== lot.lot_id) return refus(400, 'lot_id_incoherent');
  if (lot.evenements.length > LOT_MAX_EVENEMENTS) return refus(413, 'too_many_events');
  if (lot.hub_tenant_id && lot.hub_tenant_id !== abo.tenantId) return refus(409, 'tenant_incoherent');

  const vide = (raison: string): ReceptionLot => ({ statut: 200, corps: { acceptes: 0, doublons: 0, ignores: [], raison } });
  const p = paire('notifuse>crm#activite');
  const t = await db.tenant.findFirst({ where: { id: abo.tenantId, deletedAt: null }, select: { status: true, metadata: true } });
  if (!p || !t || t.status === 'suspended' || t.status === 'deleted') return vide('organisation_inactive');
  if (!evenementOuvert(p.cle, abo.tenantId, env, estDeTest(t.metadata, new Date(now)))) return vide('evenements_fermes');
  if (!porteesAccordees(p, PORTEE_CRM_MAIL) || !(await liaisonActive(db, p, abo.tenantId))) return vide('paire_eteinte');

  const cle: CleEvenement = { source: SOURCE_LOT, evenementId: lot.lot_id, messageId: lot.lot_id, cleRfc: null, tenantId: abo.tenantId };
  const r = await reserver(db, cle, now);
  if (r === 'deja') return { statut: 200, corps: { acceptes: 0, doublons: lot.evenements.length, ignores: [] } };
  if (r === 'en_cours') return refus(503, 'en_cours', 30);

  const ignores: { index: number; raison: string }[] = [];
  const retenus: Record<string, unknown>[] = [];
  lot.evenements.forEach((e, index) => {
    const x = trierEvenement(e, now);
    if ('ok' in x) retenus.push(x.ok);
    else ignores.push({ index, raison: x.raison });
  });
  if (retenus.length === 0) {
    await terminer(db, cle, 'ignore', 'rien_a_relayer', now).catch(() => undefined);
    return { statut: 200, corps: { acceptes: 0, doublons: 0, ignores } };
  }

  let lignes;
  let jti: string;
  try {
    ({ lignes, jti } = await ecrireEvenementsMail(db, { tenantId: abo.tenantId, workspaceId: ws, lotId: lot.lot_id, evenements: retenus }, env, fetchImpl));
  } catch (err) {
    await liberer(db, cle).catch(() => undefined);
    const erreur = causeEchecCrm(err);
    await writeAuditLog(db as PrismaClient, { action: 'evenement.echec', actor: `app:${SOURCE}`, targetType: 'tenant', targetId: abo.tenantId, payload: { paire: p.cle, lot_id: lot.lot_id, erreur } }).catch(() => undefined);
    if (err instanceof AppDebit) return refus(429, 'crm_rate_limited', Math.ceil(err.attenteMs / 1000));
    // 503, jamais 502 : Cloudflare remplace un 502 de l'origine par sa propre page (26/11).
    return refus(503, erreur, 60);
  }
  // Le CRM a répondu : plus rien ci-dessous ne rend un 5xx (Mail rejouerait un lot rangé).
  await terminer(db, cle, 'fait', undefined, now).catch(() => undefined);
  await noterPassage(db, p, abo.tenantId, new Date(now)).catch(() => undefined);
  // Ni adresse ni contenu : le lot, les comptes par type et par nature (valeurs fermées), le jeton.
  const compter = (cle: 'event' | 'nature') => retenus.reduce<Record<string, number>>((acc, e) => ({ ...acc, [String(e[cle])]: (acc[String(e[cle])] ?? 0) + 1 }), {});
  await writeAuditLog(db as PrismaClient, { action: 'evenement.lot', actor: `app:${SOURCE}`, targetType: 'tenant', targetId: abo.tenantId, payload: { paire: p.cle, lot_id: lot.lot_id, recus: lot.evenements.length, relayes: retenus.length, ignores: ignores.length, evenements: compter('event'), natures: compter('nature'), crm: lignes, jti } }).catch(() => undefined);
  return { statut: 200, corps: { acceptes: retenus.length, doublons: 0, ignores, crm: lignes } };
}
