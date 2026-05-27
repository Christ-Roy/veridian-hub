/**
 * Tests structuraux de `auth.ts` — la config NextAuth complète (Node runtime).
 *
 * **Pourquoi ces tests existent** : l'incident OAuth 2026-05-20→21 a montré
 * qu'un trou dans la config NextAuth (event `createUser` manquant) peut
 * passer entre tous les filets et casser le dashboard en prod. `auth.config.ts`
 * a son test structurel ; il manquait l'équivalent pour `auth.ts`.
 *
 * Ces tests verrouillent les **invariants de config** qui doivent rester
 * vrais quoi que devienne le code :
 *   - Auth.js exporte bien `auth`, `handlers`, `signIn`, `signOut`
 *   - Le callback `signIn` est câblé (sinon MFA + scénarios OAuth A→F cassent)
 *   - L'event `createUser` est câblé (sinon supabaseUserId NULL — bug 2026-05-21)
 *   - L'adapter Prisma est branché (sinon pas de persistence)
 *
 * Ces tests n'instancient pas une vraie session — pour ça il y a les E2E.
 * Ils sont là comme **smoke test de la config**, pas du runtime.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Static analysis seulement : on lit le source à plat. NextAuth dépend de
// `next/server` qui ne se résout pas dans Vitest sans setup spécifique —
// pas grave, ces tests vérifient la **forme** de la config, pas son runtime.
// Le runtime est validé par les E2E sur staging.
const authSource = fs.readFileSync(
  path.join(process.cwd(), 'auth.ts'),
  'utf8',
);

describe('auth.ts — exports NextAuth complets', () => {
  it('destructure auth + handlers + signIn + signOut depuis NextAuth()', () => {
    expect(authSource).toMatch(
      /export\s+const\s+\{\s*auth\s*,\s*handlers\s*,\s*signIn\s*,\s*signOut\s*\}\s*=\s*NextAuth\(/,
    );
  });
});

describe('auth.ts — invariants de config critiques', () => {
  it('câble adapter PrismaAdapter (sinon pas de persistence users/sessions)', () => {
    expect(authSource).toMatch(/adapter:\s*PrismaAdapter\(/);
  });

  it('câble le callback signIn (sinon MFA + scénarios OAuth A→F cassent)', () => {
    // Tolère plusieurs styles : `signIn: createSignInCallback(`, `signIn(`,
    // mais exige que la clé `signIn` apparaisse dans un bloc `callbacks`.
    expect(authSource).toMatch(/callbacks:\s*\{[\s\S]*?signIn:/);
  });

  it('câble le callback session (sinon session.user.id absent)', () => {
    expect(authSource).toMatch(/callbacks:\s*\{[\s\S]*?session\(/);
  });

  it('câble le callback jwt (sinon token.uid absent)', () => {
    expect(authSource).toMatch(/callbacks:\s*\{[\s\S]*?jwt\(/);
  });

  it('câble events.createUser (filet OAuth supabaseUserId — régression 2026-05-21)', () => {
    // **Ce test aurait catché l'incident 2026-05-20→21.**
    // Si quelqu'un supprime ou commente events.createUser, ce test fail —
    // donc le bug `supabaseUserId NULL` ne peut plus partir en prod sans
    // qu'au moins ce test rouge soit visible.
    expect(authSource).toMatch(/events:\s*\{[\s\S]*?createUser:/);
  });

  it('utilise le module createCreateUserEvent (DI propre, mockable)', () => {
    // Évite qu'un dev inline le code de l'event dans auth.ts (= non testable).
    // Force à passer par lib/auth/create-user-event.ts qui a 6 tests unitaires.
    expect(authSource).toMatch(/createCreateUserEvent\s*\(/);
  });

  it('CredentialsProvider est branché (Node runtime, ne va PAS dans auth.config)', () => {
    // Le CredentialsProvider ne peut PAS être dans auth.config.ts (Prisma
    // edge-incompatible). Il doit absolument être ajouté côté auth.ts.
    expect(authSource).toMatch(/Credentials\s*\(/);
  });

  it('mock OAuth provider câblé conditionnellement (E2E staging only, jamais en prod)', () => {
    // Filet anti-régression : si quelqu'un retire le branchement du mock
    // provider, les E2E OAuth ne tournent plus → on revient au trou de
    // couverture qui a permis le bug 2026-05-21.
    expect(authSource).toMatch(/buildMockOauthProvider\s*\(/);
    // Doit être inséré conditionnellement (spread + check). Si quelqu'un
    // l'inline sans guard, c'est une backdoor — refuse.
    expect(authSource).toMatch(/mockOauthProvider\s*\?\s*\[mockOauthProvider\]\s*:\s*\[\]/);
  });

  it('provider Google One Tap câblé conditionnellement (null en staging Tailscale)', () => {
    // Le câblage One Tap a été ajouté côté auth.ts (le provider lui-même
    // est testé dans google-one-tap-provider.test.ts). Ici on verrouille
    // uniquement que auth.ts l'instancie ET l'insère sous garde — comme le
    // mock provider, il doit renvoyer null en staging / sans client_id et
    // être exclu du tableau plutôt qu'inliné sans guard.
    expect(authSource).toMatch(/buildGoogleOneTapProvider\s*\(/);
    expect(authSource).toMatch(
      /googleOneTapProvider\s*\?\s*\[googleOneTapProvider\]\s*:\s*\[\]/,
    );
  });

  it('cookie session scopé via resolveSessionCookieConfig (cross-subdomain landing)', () => {
    // Le cookie de session DOIT passer par le helper centralisé pour que la
    // landing CF Pages (veridian.site) puisse partager la session avec le
    // Hub (app.veridian.site). Si quelqu'un retire l'override `cookies:` ou
    // inline une config sans helper, on perd le scope `.veridian.site` et
    // /api/me/lite côté landing renverra toujours {authenticated:false}.
    // Cf. docs/CROSS-SUBDOMAIN-LANDING.md.
    expect(authSource).toMatch(/cookies:\s*resolveSessionCookieConfig\s*\(/);
    expect(authSource).toMatch(/resolveSessionCookieConfig.*from.*@\/lib\/auth\/cookie-scope/);
  });

  it('le logger Auth.js émet [auth-error][critical] sur Configuration + OAuthCallbackError', () => {
    // Garde-fou monitoring Grafana Loki. Si quelqu'un retire le logger
    // structuré, les incidents OAuth deviennent invisibles dans les
    // dashboards.
    expect(authSource).toMatch(/\[auth-error\]\[critical\]/);
    expect(authSource).toMatch(/Configuration|OAuthCallbackError/);
  });
});

describe('auth.ts — câblage audit OAuth (oauth_signin_events)', () => {
  // Vérifie le BRANCHEMENT du logger d'audit OAuth dans auth.ts. Le logger
  // lui-même (lib/auth/oauth-event-log.ts) a ses 12 tests unitaires dédiés —
  // ici on verrouille uniquement qu'il reste câblé sur les deux issues du
  // flow (succès via event signIn, échec via logger.error). Si quelqu'un
  // débranche un des deux, la table d'audit se vide en silence.

  it('instancie le logger d\'audit via createOauthEventLogger', () => {
    // Force le passage par le module DI testable plutôt qu'un inline.
    expect(authSource).toMatch(/createOauthEventLogger\s*\(/);
  });

  it('câble le succès OAuth : event signIn appelle recordOauthSuccess', () => {
    // L'event `signIn` Auth.js v5 (≠ callback signIn) n'est appelé que sur
    // succès — c'est le point de log d'un login OAuth réussi.
    expect(authSource).toMatch(/events:\s*\{[\s\S]*?signIn\s*\(/);
    expect(authSource).toMatch(/recordOauthSuccess\s*\(/);
  });

  it('filtre les providers OAuth (Credentials exclu de la table d\'audit)', () => {
    // Garde-fou : un login Credentials ne doit PAS polluer oauth_signin_events.
    // Le set OAUTH_PROVIDER_IDS gate l'appel à recordOauthSuccess.
    expect(authSource).toMatch(/OAUTH_PROVIDER_IDS/);
    expect(authSource).toMatch(/OAUTH_PROVIDER_IDS\.has\(/);
  });

  it('google-one-tap est tracé comme un vrai sign-in OAuth (présent dans OAUTH_PROVIDER_IDS)', () => {
    // `google-one-tap` est techniquement un provider Credentials, mais c'est
    // un vrai login Google (id_token GSI validé). Il doit donc figurer dans
    // OAUTH_PROVIDER_IDS pour que les sign-in One Tap remontent dans
    // oauth_signin_events au lieu d'être confondus avec un login mot de passe.
    expect(authSource).toMatch(
      /OAUTH_PROVIDER_IDS\s*=\s*new Set\(\[[\s\S]*?'google-one-tap'[\s\S]*?\]\)/,
    );
  });

  it('câble l\'échec OAuth : logger.error appelle recordOauthFailure sur les error names OAuth', () => {
    // Les échecs ne passent pas par l'event signIn — ils sont captés par
    // l'override logger.error et filtrés sur OAUTH_FAILURE_ERROR_NAMES.
    expect(authSource).toMatch(/OAUTH_FAILURE_ERROR_NAMES/);
    expect(authSource).toMatch(/OAUTH_FAILURE_ERROR_NAMES\.has\(/);
    expect(authSource).toMatch(/recordOauthFailure\s*\(/);
  });
});

describe('auth.ts — câblage claims impersonation', () => {
  // Vérifie que les callbacks jwt/session propagent le marqueur
  // d'impersonation. La pose du claim se fait ailleurs (route
  // impersonate-callback) et le helper isImpersonatedSession a ses propres
  // tests — ici on verrouille uniquement que auth.ts ne mange pas le claim
  // au refresh (callback jwt) et l'expose côté session (callback session).

  it('le callback jwt préserve le token (claims impersonated survivent au refresh)', () => {
    // Le callback jwt doit retourner `token` tel quel — sinon les claims
    // `impersonated` / `impersonatedBy` posés par la route impersonate
    // seraient perdus au premier updateAge.
    expect(authSource).toMatch(/jwt\s*\([\s\S]*?return\s+token/);
  });

  it('le callback session expose le claim impersonated', () => {
    // Sans cette propagation, ni la bannière d'impersonation ni le garde-fou
    // anti-ré-impersonation (authenticateAdmin) ne verraient l'état.
    expect(authSource).toMatch(/token\?\.impersonated\s*===\s*true/);
    expect(authSource).toMatch(/session\.user\.impersonated\s*=/);
  });

  it('le callback session propage aussi impersonatedBy', () => {
    // L'identité de l'admin impersonateur doit remonter pour l'affichage
    // bannière + l'audit.
    expect(authSource).toMatch(/session\.user\.impersonatedBy\s*=/);
  });
});
