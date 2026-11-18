/**
 * Serveur OAuth 2.1 du Hub pour les clients IA (docs/CONTRAT-MCP.md) : enregistrement dynamique,
 * code + PKCE, jetons opaques à rotation. Seules les empreintes sont en base : une fuite de la
 * table ne donne aucun jeton utilisable.
 */
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { ACCESS_TTL_S, CODE_TTL_S, MCP_SCOPE, REFRESH_TTL_S, mcpResource } from './config';
import { empreinte, jetonAleatoire, pkceValide } from './crypto';

type Db = Pick<PrismaClient, 'oauthClient' | 'oauthCode' | 'oauthToken' | 'user'>;

export class OauthErreur extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  corps() {
    return { error: this.code, error_description: this.description };
  }
}

const SCHEMAS_INTERDITS = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);
const BOUCLES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Adresse de retour admise : https, http seulement en boucle locale (clients en ligne de
 * commande), ou schéma privé d'une app de bureau (RFC 8252). Jamais de fragment.
 */
export function redirectUriValide(brut: unknown): brut is string {
  if (typeof brut !== 'string' || brut.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(brut);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (SCHEMAS_INTERDITS.has(u.protocol)) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return BOUCLES.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

export async function enregistrerClient(db: Db, meta: Record<string, unknown>) {
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(redirectUriValide)) {
    throw new OauthErreur('invalid_redirect_uri', 'redirect_uris : https, http en boucle locale ou schéma d\'app, sans fragment');
  }
  const methode = meta.token_endpoint_auth_method ?? 'none';
  if (methode !== 'none') {
    throw new OauthErreur('invalid_client_metadata', 'clients publics seulement : token_endpoint_auth_method = none, PKCE obligatoire');
  }
  const nomBrut = typeof meta.client_name === 'string' ? meta.client_name : 'Client IA';
  const name = nomBrut.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Client IA';
  const clientId = jetonAleatoire('mcpc');
  await db.oauthClient.create({ data: { clientId, name, redirectUris: uris as string[] } });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export type DemandeAutorisation = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string;
  clientName: string;
};

/**
 * Valide une demande d'autorisation. Client ou adresse de retour inconnus : `fatale` (on ne
 * redirige jamais vers une adresse non enregistrée). Le reste : erreur rendue au client.
 */
export async function validerDemande(
  db: Db,
  p: Record<string, string | undefined>,
): Promise<{ ok: true; demande: DemandeAutorisation } | { ok: false; fatale: boolean; erreur: OauthErreur; redirectUri?: string; state?: string }> {
  const client = p.client_id ? await db.oauthClient.findUnique({ where: { clientId: p.client_id } }) : null;
  if (!client) return { ok: false, fatale: true, erreur: new OauthErreur('invalid_client', 'client inconnu') };
  if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
    return { ok: false, fatale: true, erreur: new OauthErreur('invalid_request', 'adresse de retour non enregistrée pour ce client') };
  }
  const retour = { redirectUri: p.redirect_uri, state: p.state };
  if (p.response_type !== 'code') return { ok: false, fatale: false, erreur: new OauthErreur('unsupported_response_type', 'response_type=code seulement'), ...retour };
  if (!p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
    return { ok: false, fatale: false, erreur: new OauthErreur('invalid_request', 'PKCE S256 obligatoire'), ...retour };
  }
  const resource = p.resource || mcpResource();
  if (resource.replace(/\/+$/, '') !== mcpResource()) {
    return { ok: false, fatale: false, erreur: new OauthErreur('invalid_target', 'ressource inconnue'), ...retour };
  }
  return {
    ok: true,
    demande: {
      clientId: client.clientId,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      state: p.state ?? null,
      scope: MCP_SCOPE,
      resource: mcpResource(),
      clientName: client.name,
    },
  };
}

export async function creerCode(db: Db, d: DemandeAutorisation, hubUserId: string): Promise<string> {
  const code = jetonAleatoire('mcpa');
  await db.oauthCode.create({
    data: {
      codeHash: empreinte(code),
      clientId: d.clientId,
      hubUserId,
      redirectUri: d.redirectUri,
      codeChallenge: d.codeChallenge,
      scope: d.scope,
      resource: d.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_S * 1000),
    },
  });
  return code;
}

async function emettre(db: Db, c: { clientId: string; hubUserId: string; scope: string; resource: string; familyId?: string }) {
  const familyId = c.familyId ?? randomUUID();
  const access = jetonAleatoire('mcpt');
  const refresh = jetonAleatoire('mcpr');
  const now = Date.now();
  const base = { familyId, clientId: c.clientId, hubUserId: c.hubUserId, scope: c.scope, resource: c.resource };
  await db.oauthToken.create({ data: { ...base, kind: 'access', tokenHash: empreinte(access), expiresAt: new Date(now + ACCESS_TTL_S * 1000) } });
  await db.oauthToken.create({ data: { ...base, kind: 'refresh', tokenHash: empreinte(refresh), expiresAt: new Date(now + REFRESH_TTL_S * 1000) } });
  void db.oauthClient.update({ where: { clientId: c.clientId }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: c.scope };
}

/** Compte encore valable : existe, et n'a pas été « déconnecté partout » après `depuis`. */
async function compteValable(db: Db, hubUserId: string, depuis: Date): Promise<boolean> {
  const u = await db.user.findUnique({ where: { supabaseUserId: hubUserId }, select: { sessionsValidAfter: true, emailVerified: true } });
  if (!u || !u.emailVerified) return false;
  return !u.sessionsValidAfter || u.sessionsValidAfter <= depuis;
}

export async function echangerCode(db: Db, p: Record<string, string | undefined>) {
  if (!p.code || !p.client_id || !p.redirect_uri || !p.code_verifier) {
    throw new OauthErreur('invalid_request', 'code, client_id, redirect_uri et code_verifier requis');
  }
  const codeHash = empreinte(p.code);
  // Usage unique, atomique : deux échanges simultanés, un seul gagne.
  const pris = await db.oauthCode.updateMany({
    where: { codeHash, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (pris.count !== 1) throw new OauthErreur('invalid_grant', 'code invalide, expiré ou déjà utilisé');
  const c = await db.oauthCode.findUnique({ where: { codeHash } });
  if (!c || c.clientId !== p.client_id || c.redirectUri !== p.redirect_uri) {
    throw new OauthErreur('invalid_grant', 'code émis pour un autre client ou une autre adresse');
  }
  if (!pkceValide(p.code_verifier, c.codeChallenge)) throw new OauthErreur('invalid_grant', 'PKCE refusé');
  if (p.resource && p.resource.replace(/\/+$/, '') !== c.resource) throw new OauthErreur('invalid_target', 'ressource différente de l\'autorisation');
  if (!(await compteValable(db, c.hubUserId, c.createdAt))) throw new OauthErreur('invalid_grant', 'compte indisponible');
  return emettre(db, c);
}

export async function renouveler(db: Db, p: Record<string, string | undefined>) {
  if (!p.refresh_token || !p.client_id) throw new OauthErreur('invalid_request', 'refresh_token et client_id requis');
  const t = await db.oauthToken.findUnique({ where: { tokenHash: empreinte(p.refresh_token) } });
  if (!t || t.kind !== 'refresh' || t.clientId !== p.client_id) throw new OauthErreur('invalid_grant', 'jeton de renouvellement inconnu');
  if (t.revokedAt || t.expiresAt <= new Date()) throw new OauthErreur('invalid_grant', 'jeton de renouvellement révoqué ou expiré');
  if (t.usedAt) {
    // Réutilisation : le jeton a fui ou le client rejoue. Toute la famille tombe.
    await revoquerFamille(db, t.familyId);
    throw new OauthErreur('invalid_grant', 'jeton déjà utilisé : connexion révoquée');
  }
  const pris = await db.oauthToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (pris.count !== 1) {
    await revoquerFamille(db, t.familyId);
    throw new OauthErreur('invalid_grant', 'jeton déjà utilisé : connexion révoquée');
  }
  const famille = await db.oauthToken.findFirst({ where: { familyId: t.familyId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  if (!(await compteValable(db, t.hubUserId, famille?.createdAt ?? t.createdAt))) {
    await revoquerFamille(db, t.familyId);
    throw new OauthErreur('invalid_grant', 'compte indisponible ou déconnecté partout');
  }
  return emettre(db, { ...t, familyId: t.familyId });
}

export async function revoquerFamille(db: Db, familyId: string) {
  await db.oauthToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** RFC 7009 : toujours 200, même pour un jeton inconnu. Révoquer un jeton coupe sa connexion entière. */
export async function revoquer(db: Db, brut: string | undefined) {
  if (!brut) return;
  const t = await db.oauthToken.findUnique({ where: { tokenHash: empreinte(brut) } });
  if (t) await revoquerFamille(db, t.familyId);
}

export type Appelant = {
  hubUserId: string;
  clientId: string;
  /** Nom déclaré par le client IA à l'enregistrement (« Claude », « ChatGPT »…). */
  clientName?: string;
  scope: string;
  email: string;
  name: string | null;
  userId: string;
};

/** La dernière utilisation n'est réécrite qu'au plus toutes les 5 min : une écriture par appel coûterait. */
const TRACE_UTILISATION_MS = 5 * 60_000;

/** Jeton d'accès de la porte → appelant, ou null (inconnu, expiré, révoqué, compte coupé). */
export async function verifierAcces(db: Db, brut: string): Promise<Appelant | null> {
  if (!brut.startsWith('mcpt_')) return null;
  const t = await db.oauthToken.findUnique({ where: { tokenHash: empreinte(brut) } });
  if (!t || t.kind !== 'access' || t.revokedAt || t.expiresAt <= new Date()) return null;
  if (t.resource !== mcpResource()) return null;
  const u = await db.user.findUnique({
    where: { supabaseUserId: t.hubUserId },
    select: { id: true, email: true, name: true, emailVerified: true, sessionsValidAfter: true },
  });
  if (!u || !u.emailVerified) return null;
  const famille = await db.oauthToken.findFirst({ where: { familyId: t.familyId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  if (u.sessionsValidAfter && u.sessionsValidAfter > (famille?.createdAt ?? t.createdAt)) return null;
  const maintenant = Date.now();
  if (!t.lastUsedAt || maintenant - t.lastUsedAt.getTime() > TRACE_UTILISATION_MS) {
    void db.oauthToken.update({ where: { id: t.id }, data: { lastUsedAt: new Date(maintenant) } }).catch(() => {});
    void db.oauthClient.update({ where: { clientId: t.clientId }, data: { lastUsedAt: new Date(maintenant) } }).catch(() => {});
  }
  const client = await db.oauthClient.findUnique({ where: { clientId: t.clientId }, select: { name: true } });
  return { hubUserId: t.hubUserId, clientId: t.clientId, clientName: client?.name, scope: t.scope, email: u.email, name: u.name, userId: u.id };
}
