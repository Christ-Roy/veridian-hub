/**
 * Le dialogue OIDC avec le fournisseur d'une organisation (VER-227 S2) : découverte, code avec PKCE, `state`, `nonce`, `iss`, `aud` et signature
 * vérifiés par `openid-client`. La transaction vit 10 min dans un cookie scellé, lié au navigateur qui l'a ouverte (M7).
 */
import * as oidc from 'openid-client';
import { z } from 'zod';

import { chiffrer, dechiffrer } from '@/lib/ia/coffre';

import { adresseAcceptee, type IdpPret } from './idp';
import { fetchGarde } from './sortie';

export const COOKIE_FEDERATION = 'veridian-federation';
export const CHEMIN_RETOUR = '/api/auth/federation/callback';
export const TRANSACTION_S = 10 * 60;
const DELAI_S = 10;

export const Transaction = z.object({ t: z.literal('federation'), idp: z.string(), state: z.string(), nonce: z.string(), verifier: z.string(), exp: z.number(), /** Ajout d'une adresse (AD-M3) : la personne qui l'a demandé, et l'adresse attendue. Aucune session n'en naît. */ ajout: z.object({ userId: z.string(), email: z.string() }).optional(), /** Liaison par la personne (VER-261) : elle seule peut la finir. Aucune session n'en naît. */ relier: z.object({ userId: z.string() }).optional(), /** Essai par le propriétaire avant d'activer (VER-227) : rien n'est relié, aucune session n'en naît. */ essai: z.object({ userId: z.string() }).optional(), /** Sa session passe par le fournisseur de son organisation (lib/federation/prouver.ts). */ prouver: z.object({ userId: z.string() }).optional(), /** Essai sans écran (prompt=none) : un seul par aller ; un refus rend le bouton, jamais une boucle. */ silence: z.boolean().optional() });
export type Transaction = z.infer<typeof Transaction>;
export const sceller = (x: Omit<Transaction, 't'>): string => chiffrer(JSON.stringify({ t: 'federation', ...x }));
export function ouvrir(scelle: string | undefined, now = Date.now()): Transaction | null {
  if (!scelle) return null;
  try {
    const x = Transaction.parse(JSON.parse(dechiffrer(scelle)));
    return x.exp * 1000 > now ? x : null;
  } catch {
    return null;
  }
}

async function configuration(i: IdpPret): Promise<oidc.Configuration> {
  // Sans enableNonRepudiationChecks, la SIGNATURE du jeton n'est pas lue (la bibliothèque se fie au TLS du point de jeton) : vu par l'épreuve, 25/11.
  // En clair, seulement l'IdP jetable d'une organisation marquée (idp.ts l'a vérifié). Aucune redirection suivie : elle sortirait de l'adresse admise.
  // Hors épreuve, l'adresse réellement jointe est publique : un propriétaire écrit l'émetteur lui-même (sortie.ts).
  const c = await oidc.discovery(new URL(i.issuer), i.clientId, i.secret, oidc.ClientSecretPost(i.secret), { timeout: DELAI_S, ...(i.test ? {} : { [oidc.customFetch]: fetchGarde as never }), execute: [oidc.enableNonRepudiationChecks, ...(i.test && i.issuer.startsWith('http:') ? [oidc.allowInsecureRequests] : [])] });
  c.timeout = DELAI_S;
  if (!i.test) c[oidc.customFetch] = fetchGarde as never;
  const m = c.serverMetadata();
  if (![m.authorization_endpoint, m.token_endpoint, m.jwks_uri].every((u) => adresseAcceptee(u, i.test))) throw new Error('adresse_publiee_refusee');
  return c;
}

/** Où envoyer le navigateur, et la transaction à garder dans son cookie. */
export async function demarrer(i: IdpPret, retour: string, now = Date.now(), ajout?: { userId: string; email: string }, relier?: { userId: string }, essai?: { userId: string }, prouver?: { userId: string }, silence?: boolean): Promise<{ url: string; cookie: string }> {
  const c = await configuration(i);
  const [state, nonce, verifier] = [oidc.randomState(), oidc.randomNonce(), oidc.randomPKCECodeVerifier()];
  const url = oidc.buildAuthorizationUrl(c, { redirect_uri: retour, // Sans domaine déclaré, rien de ce qu'il dit n'est cru hors l'identifiant : on ne demande rien d'autre.
    scope: i.domaines.length ? 'openid email profile' : 'openid', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', ...(ajout ? { prompt: 'login', login_hint: ajout.email } : silence ? { prompt: 'none' } : {}) });
  return { url: url.href, cookie: sceller({ idp: i.id, state, nonce, verifier, exp: Math.floor(now / 1000) + TRANSACTION_S, ...(ajout ? { ajout } : {}), ...(relier ? { relier } : {}), ...(essai ? { essai } : {}), ...(prouver ? { prouver } : {}), ...(silence ? { silence } : {}) }) };
}

const Claims = z.object({ sub: z.string().min(1).max(255), email: z.string().max(254).optional(), email_verified: z.union([z.boolean(), z.string()]).optional(), name: z.string().max(200).optional(), hd: z.string().max(253).optional() });
export type Identite = { sub: string; email: string | null; emailNie: boolean; nom: string | null; /** Domaine Google Workspace qui gère ce compte. */ hd?: string | null };

/** Échange le code. Lève si quoi que ce soit ne tient pas : code, state, nonce, émetteur, audience, signature, échéance. */
export async function terminer(i: IdpPret, t: Transaction, url: URL): Promise<Identite> {
  const r = await oidc.authorizationCodeGrant(await configuration(i), url, { pkceCodeVerifier: t.verifier, expectedState: t.state, expectedNonce: t.nonce, idTokenExpected: true });
  const c = Claims.parse(r.claims());
  // Seule une adresse affirmée « non vérifiée » est niée ; un fournisseur d'entreprise ne la dit souvent pas, son domaine déclaré en tient lieu.
  return { sub: c.sub, email: c.email?.trim().toLowerCase() || null, emailNie: c.email_verified === false || c.email_verified === 'false', nom: c.name ?? null, hd: c.hd?.toLowerCase() ?? null };
}
