/**
 * Visites par lots vers le CRM (CONTRAT-HUB §5.26, Robert et la parente 27/11). Analytics n'envoie que les visites d'un contact CONNU, agrégées
 * de son côté : une ligne par visiteur identifié et par session. Ordre : taille → signature de l'app (`verifierAppel`, nonce à usage unique) →
 * forme stricte du lot → plafond par organisation → organisation et paire (`analytics>crm#visite`) → dédoublonnage par session → outil CRM
 * `app_evenements_visite` (portée `crm:visite.ecrire`) → comptes. Ni adresse, ni chemin, ni identifiant de session n'est journalisé ; le Hub ne
 * garde qu'une empreinte de la session, pour dédoublonner, 30 jours.
 */
import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { liaisonActive, noterPassage } from '@/lib/delegation/etat';
import { deborde, verifierAppel } from '@/lib/delegation/jeton';
import { evenementOuvert, paire, porteesAccordees } from '@/lib/delegation/paires';
import { AppDebit } from '@/lib/mcp/client-app';
import { estDeTest } from '@/lib/tenants/marque-test';

import { ecrireVisites, PORTEE_CRM_VISITE, type LignesMail, causeEchecCrm } from './crm';
import { liberer, reserver, terminer, type CleEvenement } from './dedoublonnage';

export const VISITES_MAX_LOT = 200;
export const VISITES_MAX_OCTETS = 1_000_000;
/** Un lot par minute et par organisation au plus : au-delà, 429 (Analytics rejoue avec `Retry-After`). */
export const LOTS_PAR_MINUTE = 60;
const PASSE_MAX_MS = 7 * 86_400_000;
const FUTUR_MAX_MS = 5 * 60_000;
const CHEMIN_MAX = 300;
const CHEMINS_MAX = 100;

type Db = Pick<PrismaClient, 'delegationNonce' | 'evenementRecu' | 'integrationPaire' | 'organisation' | 'tenant' | 'mcpApp' | 'auditLog'>;
export type ReceptionVisites = { statut: number; corps: Record<string, unknown>; retryAfterS?: number };
const refus = (statut: number, error: string, retryAfterS?: number): ReceptionVisites => ({ statut, corps: { error }, retryAfterS });

/** Forme stricte : un champ de plus (un `chaine`, une adresse IP, une empreinte de navigateur) fait refuser la visite. */
const Lot = z.object({ hub_tenant_id: z.string().uuid(), lot_id: z.string().uuid(), visites: z.array(z.unknown()) });
const Visite = z.object({
  session_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
  contact_email: z.string().max(254),
  debut: z.string().min(1).max(40),
  fin: z.string().min(1).max(40),
  duree_s: z.number().int().min(0).max(86_400),
  pages_vues: z.number().int().min(1).max(10_000),
  chemins: z.array(z.string().max(2048)).min(1).max(CHEMINS_MAX),
}).strict();

/** Une session retenue : chemins sans requête ni fragment (ils portent parfois des jetons), chacun borné. Refusée : la raison, jamais la valeur. */
export function trierVisite(brut: unknown, now: number): { ok: Record<string, unknown> } | { raison: string } {
  const p = Visite.safeParse(brut);
  if (!p.success) return { raison: 'invalide' };
  const v = p.data;
  const debut = Date.parse(v.debut);
  const fin = Date.parse(v.fin);
  if (!Number.isFinite(debut) || !Number.isFinite(fin) || fin < debut) return { raison: 'date_invalide' };
  if (debut < now - PASSE_MAX_MS) return { raison: 'trop_ancien' };
  if (fin > now + FUTUR_MAX_MS) return { raison: 'futur' };
  const contact = v.contact_email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return { raison: 'email_invalide' };
  if (v.chemins.some((c) => !c.startsWith('/'))) return { raison: 'chemin_invalide' };
  const chemins = v.chemins.map((c) => c.split(/[?#]/)[0].slice(0, CHEMIN_MAX));
  return { ok: { session_id: v.session_id, contact_email: contact, debut: new Date(debut).toISOString(), fin: new Date(fin).toISOString(), duree_s: v.duree_s, pages_vues: v.pages_vues, chemins } };
}

/** Clé de ligne : l'empreinte de (organisation, session). Le Hub ne garde jamais l'identifiant de session lui-même. */
export function cleDeVisite(tenantId: string, sessionId: string): CleEvenement {
  const empreinte = createHash('sha256').update(`visite:${tenantId}:${sessionId}`).digest('hex').slice(0, 32);
  return { source: 'analytics-visite', evenementId: empreinte, messageId: empreinte, cleRfc: null, tenantId };
}

export async function recevoirVisites(db: Db, h: Headers, brut: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<ReceptionVisites> {
  if (Buffer.byteLength(brut) > VISITES_MAX_OCTETS) return refus(413, 'too_large');
  const v = await verifierAppel(db, h, brut, now, ['analytics'] as const);
  if ('statut' in v) return refus(v.statut, v.error, v.retryAfterS);
  let json: unknown = null;
  try {
    json = JSON.parse(brut);
  } catch {
    return refus(400, 'invalid_request');
  }
  const p0 = Lot.safeParse(json);
  if (!p0.success) return refus(400, 'invalid_request');
  const lot = p0.data;
  if (lot.visites.length > VISITES_MAX_LOT) return refus(413, 'too_many_events');
  const tenantId = lot.hub_tenant_id;
  if ((await deborde(`visite:${tenantId}`, now, LOTS_PAR_MINUTE))) return refus(429, 'rate_limited', 60);

  const vide = (raison: string): ReceptionVisites => ({ statut: 200, corps: { acceptes: 0, doublons: 0, ignores: [], raison } });
  const p = paire('analytics>crm#visite');
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { status: true, metadata: true } });
  if (!p || !t || t.status === 'suspended' || t.status === 'deleted') return vide('organisation_inactive');
  if (!evenementOuvert(p.cle, tenantId, env, estDeTest(t.metadata, new Date(now)))) return vide('evenements_fermes');
  // Organisation ancienne sans consentement : `etatDe` la dit éteinte (rien n'est dit consenti par défaut). Neuve : allumée d'office.
  if (!porteesAccordees(p, PORTEE_CRM_VISITE) || !(await liaisonActive(db, p, tenantId))) return vide('paire_eteinte');

  const ignores: { index: number; raison: string }[] = [];
  const vus = new Set<string>();
  let doublons = 0;
  const retenues: Record<string, unknown>[] = [];
  lot.visites.forEach((brutV, index) => {
    const x = trierVisite(brutV, now);
    if (!('ok' in x)) {
      ignores.push({ index, raison: x.raison });
      return;
    }
    const sid = String(x.ok.session_id);
    if (vus.has(sid)) {
      doublons += 1;
      return;
    }
    vus.add(sid);
    retenues.push(x.ok);
  });

  // Une ligne = une session : réservée avant l'appel, libérée si le CRM échoue (le rejeu relaie). Une réservation en cours chez un autre passage : 503.
  const reservees: CleEvenement[] = [];
  const neuves: Record<string, unknown>[] = [];
  const libererTout = () => Promise.all(reservees.map((k) => liberer(db, k).catch(() => undefined)));
  try {
    for (const visite of retenues) {
      const c = cleDeVisite(tenantId, String(visite.session_id));
      const r = await reserver(db, c, now);
      if (r === 'neuf') {
        reservees.push(c);
        neuves.push(visite);
      } else if (r === 'deja') {
        doublons += 1;
      } else {
        await libererTout();
        return refus(503, 'en_cours', 30);
      }
    }
  } catch {
    await libererTout();
    return refus(503, 'reservation_echec', 30);
  }
  if (neuves.length === 0) return { statut: 200, corps: { acceptes: 0, doublons, ignores } };

  let relais;
  try {
    relais = await ecrireVisites(db, { tenantId, lotId: lot.lot_id, visites: neuves }, env, fetchImpl);
  } catch (err) {
    await libererTout();
    const erreur = causeEchecCrm(err);
    await writeAuditLog(db as PrismaClient, { action: 'evenement.echec', actor: 'app:analytics', targetType: 'tenant', targetId: tenantId, payload: { paire: p.cle, lot_id: lot.lot_id, erreur } }).catch(() => undefined);
    if (err instanceof AppDebit) return refus(429, 'crm_rate_limited', Math.ceil(err.attenteMs / 1000));
    // 503, jamais 502 : Cloudflare remplace un 502 de l'origine par sa propre page (26/11).
    return refus(503, erreur, 60);
  }
  // Le CRM a répondu : plus rien ci-dessous ne rend un 5xx (Analytics rejouerait un lot déjà rangé).
  await Promise.all(reservees.map((k) => terminer(db, k, 'fait', undefined, now).catch(() => undefined)));
  await noterPassage(db, p, tenantId, new Date(now)).catch(() => undefined);
  const parRaison = ignores.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.raison]: (acc[x.raison] ?? 0) + 1 }), {});
  // Comptes seulement : ni contact, ni chemin, ni session.
  await writeAuditLog(db as PrismaClient, { action: 'evenement.visites', actor: 'app:analytics', targetType: 'tenant', targetId: tenantId, payload: { paire: p.cle, lot_id: lot.lot_id, recus: lot.visites.length, relayes: neuves.length, doublons, ignores: ignores.length, raisons: parRaison, crm: relais.lignes as LignesMail, jti: relais.jti } }).catch(() => undefined);
  return { statut: 200, corps: { acceptes: neuves.length, doublons, ignores, crm: relais.lignes } };
}
