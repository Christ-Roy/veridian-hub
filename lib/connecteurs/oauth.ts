/**
 * OAuth vers un service extérieur (VER-119) : découverte (RFC 8414) chez l'émetteur FIGÉ, enregistrement automatique du client (RFC 7591), code avec PKCE et
 * `state`, jeton demandé pour CE serveur (`resource`, RFC 8707), renouvellement, révocation, effacement de notre inscription (RFC 7592). Protocole :
 * `openid-client`. Sortie : `sortieOAuth`. Chaque adresse que le service annonce est comparée à son hôte du registre AVANT de servir.
 */
import * as oidc from 'openid-client';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { chiffrer, dechiffrer } from '@/lib/ia/coffre';

import { connecteur, type Connecteur } from './registre';
import { sortieOAuth, tenirAdresse, type Deps } from './sortie';
import { uneLigne } from './texte';

export type { Deps } from './sortie';

export const COOKIE_CONNECTEUR = 'veridian-connecteur';
export const CHEMIN_RETOUR_CONNECTEUR = '/api/connecteurs/retour';
export const TRANSACTION_CONNECTEUR_S = 10 * 60;

type Db = Pick<PrismaClient, 'connecteurClient'>;
/** `compte` : le nom que le service donne au compte autorisé, quand il en donne un. Un texte à lui, montré, jamais cru. */
export type Jetons = { acces: string; refresh: string | null; expireLe: Date | null; compte: string | null };

const Transaction = z.object({ t: z.literal('connecteur'), cle: z.string(), userId: z.string(), state: z.string(), verifier: z.string(), exp: z.number() });
export type TransactionConnecteur = z.infer<typeof Transaction>;
export function ouvrirTransaction(scelle: string | undefined, now = Date.now()): TransactionConnecteur | null {
  if (!scelle) return null;
  try {
    const x = Transaction.parse(JSON.parse(dechiffrer(scelle)));
    return x.exp * 1000 > now ? x : null;
  } catch {
    return null;
  }
}

const options = (c: Connecteur, d: Deps) => ({ algorithm: 'oauth2' as const, timeout: 10, [oidc.customFetch]: sortieOAuth(c, d) as never, execute: d.enClair ? [oidc.allowInsecureRequests] : [] });
const poser = (conf: oidc.Configuration, c: Connecteur, d: Deps): oidc.Configuration => { conf.timeout = 10; conf[oidc.customFetch] = sortieOAuth(c, d) as never; return conf; };

/** Le service annonce ses adresses ; chacune doit être chez l'hôte figé pour ce rôle. Une seule ailleurs : tout est refusé. */
function tenir(conf: oidc.Configuration, c: Connecteur, d: Deps): oidc.Configuration {
  const m = conf.serverMetadata();
  for (const [adresse, hote] of [
    [m.authorization_endpoint, c.oauth.autorisation],
    [m.token_endpoint, c.oauth.jeton],
    [m.registration_endpoint, c.oauth.enregistrement],
    [m.revocation_endpoint, c.oauth.revocation],
  ] as const) {
    if (adresse !== undefined) tenirAdresse(adresse, [hote], d);
  }
  return conf;
}

const decouvrir = async (c: Connecteur, id: string, secret: string | undefined, d: Deps): Promise<oidc.Configuration> =>
  tenir(poser(await oidc.discovery(new URL(c.oauth.emetteur), id, secret, secret ? oidc.ClientSecretPost(secret) : oidc.None(), options(c, d)), c, d), c, d);

/** Notre client chez ce service. Jamais inscrit d'ici : renouveler, échanger ou couper n'inscrit personne. */
async function notreClient(db: Db, c: Connecteur, retour: string, d: Deps): Promise<oidc.Configuration | null> {
  const l = await db.connecteurClient.findUnique({ where: { connecteur_retour: { connecteur: c.cle, retour } } });
  return l ? decouvrir(c, l.clientId, l.secretChiffre ? dechiffrer(l.secretChiffre) : undefined, d) : null;
}
async function configuration(db: Db, c: Connecteur, retour: string, d: Deps): Promise<oidc.Configuration> {
  const conf = await notreClient(db, c, retour, d);
  if (!conf) throw new Error('non_inscrit');
  return conf;
}

type Inscription = { clientId: string; secret: string | null; jeton: string | null; adresse: string | null };
/** L'adresse de gestion n'est gardée que chez l'hôte d'enregistrement : c'est là, et nulle part ailleurs, que partira le jeton de gestion. */
function inscriptionDe(c: Connecteur, conf: oidc.Configuration, d: Deps): Inscription {
  const id = conf.clientMetadata() as Record<string, unknown> & { client_id: string };
  const lu = (k: string) => (typeof id[k] === 'string' && (id[k] as string).length < 4_000 ? (id[k] as string) : null);
  let [jeton, adresse] = [lu('registration_access_token'), lu('registration_client_uri')];
  try {
    if (!jeton || !adresse) throw new Error('absents');
    tenirAdresse(adresse, [c.oauth.enregistrement], d);
  } catch {
    [jeton, adresse] = [null, null];
  }
  return { clientId: id.client_id, secret: lu('client_secret'), jeton, adresse };
}

async function inscrire(db: Db, c: Connecteur, retour: string, d: Deps): Promise<oidc.Configuration> {
  const m = (await decouvrir(c, 'veridian', undefined, d)).serverMetadata();
  if (!m.registration_endpoint) throw new Error('sans_enregistrement');
  const methode = (m.token_endpoint_auth_methods_supported ?? ['client_secret_basic']).includes('none') ? 'none' : 'client_secret_post';
  const conf = await oidc.dynamicClientRegistration(
    new URL(c.oauth.emetteur),
    { client_name: 'Veridian', client_uri: 'https://veridian.site', redirect_uris: [retour], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: methode, ...(c.portee ? { scope: c.portee } : {}) },
    methode === 'none' ? oidc.None() : oidc.ClientSecretPost(),
    options(c, d),
  );
  const i = inscriptionDe(c, conf, d);
  try {
    tenir(poser(conf, c, d), c, d);
    await db.connecteurClient.create({ data: { connecteur: c.cle, retour, clientId: i.clientId, secretChiffre: i.secret ? chiffrer(i.secret) : null, gestionChiffre: i.jeton ? chiffrer(JSON.stringify({ jeton: i.jeton, adresse: i.adresse })) : null } });
  } catch (err) {
    // Non gardée (une autre version l'a inscrit avant nous, adresses changées) : la nôtre ne reste pas chez lui si on sait l'effacer.
    const efface = await effacerChez(c, i, d);
    console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'inscription non gardée', connecteur: c.cle, efface }));
    const autre = err instanceof Error && (err as { code?: string }).code === 'P2002' ? await notreClient(db, c, retour, d) : null;
    if (autre) return autre;
    throw err;
  }
  return conf;
}

/** Une seule inscription à la fois par service : deux départs ensemble ne doivent pas en laisser deux chez lui. */
const inscriptions = new Map<string, Promise<oidc.Configuration>>();
async function notreClientOuInscription(db: Db, c: Connecteur, retour: string, d: Deps): Promise<oidc.Configuration> {
  const k = `${c.cle} ${retour}`;
  const enCours = inscriptions.get(k);
  if (enCours) return enCours;
  const p = (async () => (await notreClient(db, c, retour, d)) ?? inscrire(db, c, retour, d))().finally(() => inscriptions.delete(k));
  inscriptions.set(k, p);
  return p;
}

/** RFC 7592. Vrai seulement si le service le confirme (204), ou ne nous connaît déjà plus (404). */
async function effacerChez(c: Connecteur, i: { jeton: string | null; adresse: string | null }, d: Deps): Promise<boolean> {
  if (!i.jeton || !i.adresse) return false;
  try {
    const u = tenirAdresse(i.adresse, [c.oauth.enregistrement], d);
    const r = await sortieOAuth(c, d)(u.href, { method: 'DELETE', headers: { authorization: `Bearer ${i.jeton}` } });
    return r.status === 204 || r.status === 404;
  } catch {
    return false;
  }
}

/** Efface notre inscription chez ce service. Gardée chez nous tant qu'il ne l'a pas confirmé. */
export async function desinscrire(db: Db, c: Connecteur, retour: string, d: Deps = {}): Promise<'effacee' | 'absente' | 'sans_jeton' | 'echec'> {
  const l = await db.connecteurClient.findUnique({ where: { connecteur_retour: { connecteur: c.cle, retour } } });
  if (!l) return 'absente';
  if (!l.gestionChiffre) return 'sans_jeton';
  if (!(await effacerChez(c, JSON.parse(dechiffrer(l.gestionChiffre)) as { jeton: string; adresse: string }, d))) return 'echec';
  await db.connecteurClient.deleteMany({ where: { connecteur: c.cle, retour, clientId: l.clientId } });
  return 'effacee';
}

export async function partir(db: Db, c: Connecteur, userId: string, retour: string, d: Deps = {}): Promise<{ url: string; cookie: string }> {
  const conf = await notreClientOuInscription(db, c, retour, d);
  const [state, verifier] = [oidc.randomState(), oidc.randomPKCECodeVerifier()];
  const url = oidc.buildAuthorizationUrl(conf, { redirect_uri: retour, state, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', resource: c.mcpUrl, ...(c.portee ? { scope: c.portee } : {}) });
  tenirAdresse(url.href, [c.oauth.autorisation], d);
  const t: TransactionConnecteur = { t: 'connecteur', cle: c.cle, userId, state, verifier, exp: Math.floor((d.now ?? Date.now()) / 1000) + TRANSACTION_CONNECTEUR_S };
  return { url: url.href, cookie: chiffrer(JSON.stringify(t)) };
}

const lire = (r: oidc.TokenEndpointResponse, now: number): Jetons => ({
  acces: r.access_token,
  refresh: typeof r.refresh_token === 'string' ? r.refresh_token : null,
  expireLe: typeof r.expires_in === 'number' ? new Date(now + r.expires_in * 1000) : null,
  compte: uneLigne((r as Record<string, unknown>).workspace_name, 80),
});

/** Échange le code. Lève si quoi que ce soit ne tient pas : state, code, PKCE, retour. */
export async function terminer(db: Db, t: TransactionConnecteur, url: URL, retour: string, d: Deps = {}): Promise<Jetons> {
  const c = connecteur(t.cle);
  if (!c) throw new Error('connecteur_inconnu');
  const conf = await configuration(db, c, retour, d);
  return lire(await oidc.authorizationCodeGrant(conf, url, { pkceCodeVerifier: t.verifier, expectedState: t.state }, { resource: c.mcpUrl }), d.now ?? Date.now());
}

export async function renouveler(db: Db, c: Connecteur, refresh: string, retour: string, d: Deps = {}): Promise<Jetons> {
  const j = lire(await oidc.refreshTokenGrant(await configuration(db, c, retour, d), refresh, { resource: c.mcpUrl }), d.now ?? Date.now());
  // Un service qui ne tourne pas ses jetons garde le même.
  return { ...j, refresh: j.refresh ?? refresh };
}

/** Révoque CHAQUE jeton. Vrai seulement si le service les a tous acceptés : le moindre doute se dit, jamais « coupé chez lui » par défaut. */
export async function revoquer(db: Db, c: Connecteur, jetons: readonly string[], retour: string, d: Deps = {}): Promise<boolean> {
  try {
    const conf = await configuration(db, c, retour, d);
    const faits = [];
    for (const j of jetons) faits.push(await oidc.tokenRevocation(conf, j).then(() => true, () => false));
    return jetons.length > 0 && faits.every(Boolean);
  } catch {
    return false;
  }
}
