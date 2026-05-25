/**
 * Wrapper OAuth2Client pour le Client OAuth Google **Veridian Mail Sender**
 * (Client 2 — distinct du Client 1 sign-in).
 *
 * Pattern multi-clients OAuth Google (standard industriel Notion / Linear /
 * HubSpot) : on isole le scope sensitive `gmail.send` dans son propre Client
 * OAuth pour ne pas mélanger le sign-in basic (`openid email profile`,
 * Client 1) avec le scope sensitive qui nécessitera une brand verification
 * Google Trust & Safety lorsqu'on dépassera 100 users beta.
 *
 * Credentials :
 *   - `GOOGLE_MAIL_CLIENT_ID` (env)
 *   - `GOOGLE_MAIL_CLIENT_SECRET` (env)
 *   - Origins + redirect URIs déclarés côté Console pour
 *     https://app.veridian.site, https://hub.staging.veridian.site,
 *     http://localhost:3000 (callback path = /api/gmail/connect/callback).
 *
 * Ce module est volontairement minimal — il fournit :
 *   1. `getMailOAuthClient(redirectUri)` : fabrique d'OAuth2Client typé
 *   2. `getMailAuthUrl(state, redirectUri)` : URL de consent avec scopes
 *      gmail.send + offline access (pour récupérer un refresh_token)
 *   3. `exchangeMailCode(code, redirectUri)` : échange code → tokens
 *
 * La logique métier (persistance Account, envoi mail) vit dans
 * `lib/mail/send-gmail.ts` et les routes `app/api/gmail/*`.
 */

import { OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';

/**
 * Scopes demandés au consent screen pour le Client 2 "Veridian Mail Sender".
 *
 * - `openid` + `email` + `profile` : permet à Google de nous retourner
 *   l'email + l'id_token (qu'on utilise pour confirmer quel compte Google
 *   l'user a connecté, et le matcher avec l'email Hub).
 * - `gmail.send` : SCOPE SENSITIVE. Permet d'appeler
 *   `gmail.users.messages.send` au nom de l'user. Pas de lecture (`gmail.readonly`
 *   serait restricted = audit Google requis), pas de modification de la boîte.
 *
 * Cf. https://developers.google.com/identity/protocols/oauth2/scopes#gmail
 */
export const GMAIL_SEND_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export type GmailTokenExchange = {
  /** access_token court (≤1h) — utilisé pour les appels Gmail API immédiats. */
  access_token: string;
  /** refresh_token long (forever en mode Production publié). Indispensable. */
  refresh_token: string;
  /** Epoch ms d'expiration du access_token (NOT le delta). */
  expires_at: number;
  /** id_token JWT signé Google — nous fournit email + sub vérifiés. */
  id_token: string;
  /** Email du compte Google connecté (parsé depuis l'id_token). */
  email: string;
  /** Subject = identifiant Google stable du compte (parsé depuis l'id_token). */
  sub: string;
  /** Scopes effectivement accordés par l'user (CSV, sépareur espace). */
  granted_scope: string;
};

/**
 * Fabrique un OAuth2Client typé pour le flow Mail Sender.
 *
 * `redirectUri` doit matcher EXACTEMENT une des URIs déclarées en Console
 * (sinon Google renvoie redirect_uri_mismatch). On le passe à chaque appel
 * pour supporter staging / prod / localhost sans configuration globale.
 *
 * Throw si les ENV ne sont pas configurées — la route appelante (qui veut
 * démarrer le flow OAuth ou échanger un code) doit alors retourner 503,
 * pas une 500 silencieuse.
 */
export function getMailOAuthClient(redirectUri: string): OAuth2Client {
  const clientId = process.env.GOOGLE_MAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_MAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_MAIL_CLIENT_ID / GOOGLE_MAIL_CLIENT_SECRET not configured ' +
        '— Mail Gateway OAuth flow disabled.',
    );
  }

  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
  });
}

/**
 * Génère l'URL Google consent pour démarrer le flow Mail Sender.
 *
 * Paramètres clés :
 *   - `access_type: 'offline'` : indispensable pour recevoir un refresh_token.
 *     Sans ça, Google ne donne qu'un access_token court et impossible de
 *     re-refresh sans demander à l'user de re-consent à chaque heure.
 *   - `prompt: 'consent'` : force le re-consent même si l'user a déjà donné
 *     le scope auparavant. Garantit qu'on récupère un refresh_token frais
 *     (Google ne renvoie pas de refresh_token si la combinaison user+client+scope
 *     a déjà été consentie sans `prompt=consent`).
 *   - `include_granted_scopes: true` : incremental authorization — si l'user
 *     a déjà consenti à `openid email profile` côté Client 1 sign-in, le
 *     consent fusionne plutôt que de tout réinitialiser.
 *   - `state` : opaque, vérifié par le callback (CSRF).
 */
export function getMailAuthUrl(state: string, redirectUri: string): string {
  const client = getMailOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...GMAIL_SEND_SCOPES],
    state,
  });
}

/**
 * Décode un id_token JWT Google sans vérifier la signature.
 *
 * Sécurité : on ne vérifie PAS la signature ici parce que le code a été
 * échangé directement avec Google via le secret client (canal authentifié)
 * — donc l'id_token retourné est forcément valide. On extrait juste `email`
 * et `sub` pour l'attribuer à l'Account.
 *
 * Si on voulait re-vérifier (defense in depth), on utiliserait
 * `client.verifyIdToken({ idToken, audience: clientId })` mais ça ajoute
 * un round-trip réseau pour zero bénéfice ici.
 */
function decodeIdToken(idToken: string): { email: string; sub: string } {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid id_token format');
  }
  const payloadB64 = parts[1];
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  const claims = JSON.parse(payload) as { email?: string; sub?: string };
  if (!claims.email || !claims.sub) {
    throw new Error('id_token missing email or sub claim');
  }
  return { email: claims.email, sub: claims.sub };
}

/**
 * Échange un authorization code reçu sur le callback contre les tokens
 * Google (access + refresh + id_token).
 *
 * Throw si :
 *   - le code est invalide / expiré (Google répond 400)
 *   - Google ne retourne pas de refresh_token (cas pathologique — devrait
 *     toujours être présent grâce à `prompt: 'consent'` + `access_type: 'offline'`)
 *   - l'id_token est absent ou malformé
 */
export async function exchangeMailCode(
  code: string,
  redirectUri: string,
): Promise<GmailTokenExchange> {
  const client = getMailOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  return normalizeTokens(tokens);
}

/**
 * Normalise un objet `Credentials` (retour de getToken / refreshAccessToken)
 * vers notre shape `GmailTokenExchange`. Exporté pour permettre aux tests
 * unitaires de fabriquer un fake retour Google sans monter d'OAuth2Client.
 */
export function normalizeTokens(tokens: Credentials): GmailTokenExchange {
  if (!tokens.access_token) {
    throw new Error('Google did not return an access_token');
  }
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token — vérifier que prompt=consent ' +
        'et access_type=offline sont bien dans l\'URL de consent.',
    );
  }
  if (!tokens.id_token) {
    throw new Error('Google did not return an id_token');
  }

  const { email, sub } = decodeIdToken(tokens.id_token);

  // Google retourne `expiry_date` (epoch ms). On garde le même format pour
  // simplifier la comparaison côté refresh logic.
  const expires_at =
    typeof tokens.expiry_date === 'number'
      ? tokens.expiry_date
      : Date.now() + 60 * 60 * 1000;

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at,
    id_token: tokens.id_token,
    email,
    sub,
    granted_scope: tokens.scope ?? '',
  };
}

/**
 * Helper : retourne true si la chaîne `scopeCsv` (typiquement le contenu de
 * `Account.mailSendScope`) contient le scope gmail.send. Centralisé pour
 * éviter les bugs de comparaison (Google peut retourner avec ou sans le
 * préfixe `https://www.googleapis.com/auth/`).
 */
export function scopeIncludesGmailSend(scopeCsv: string | null | undefined): boolean {
  if (!scopeCsv) return false;
  return scopeCsv.includes('gmail.send');
}
