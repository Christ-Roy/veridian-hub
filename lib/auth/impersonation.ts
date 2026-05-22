/**
 * Impersonation — helpers partagés entre la route admin (génération de
 * token) et le callback user-side (consommation + pose du cookie session).
 *
 * Modèle de sécurité (tier 🔴 HAUT — c'est de l'AUTH) :
 *
 *  1. Seul un platform admin peut DÉCLENCHER une impersonation. Vérifié en
 *     amont par `authenticateAdmin` / `isPlatformAdmin` dans les routes.
 *  2. Le token impersonate est **court-vécu** (10 min), **usage unique**
 *     (delete-on-consume atomique) et **stocké hashé** (SHA-256) — un dump
 *     de la table `verification_tokens` ne révèle aucun token utilisable.
 *  3. La session Auth.js posée par le callback est un **vrai JWT Auth.js**
 *     (encode/@auth/core), donc indistinguable d'un login normal côté
 *     middleware — sauf qu'elle porte deux claims supplémentaires :
 *       - `impersonated: true`
 *       - `impersonatedBy: <email admin>`
 *  4. Anti-ré-impersonation : `isImpersonatedSession()` lit ces claims.
 *     Les routes admin (impersonate-set, /api/admin/*) refusent toute
 *     session marquée `impersonated` → un user impersoné ne peut pas
 *     rebondir pour impersoner quelqu'un d'autre.
 *
 * Pourquoi PAS la table `Session` : la stratégie de session du Hub est
 * `jwt` (cf. auth.config.ts). Auth.js ne lit JAMAIS la table `sessions` en
 * mode JWT — créer une row `Session` ne produit aucune session valide. Le
 * cookie attendu est un JWE signé avec `AUTH_SECRET`.
 *
 * Pourquoi `VerificationToken` pour stocker le token impersonate : la table
 * existe déjà (magic links / OTP), a la bonne forme (`identifier`, `token`
 * unique, `expires`) et la contrainte `@@unique([identifier, token])`. On
 * préfixe l'identifier `impersonate:` pour ne jamais collisionner avec un
 * magic link légitime.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import type { PrismaClient } from '@prisma/client';

/** Préfixe d'identifier dans `verification_tokens` — isole les tokens impersonate. */
export const IMPERSONATION_IDENTIFIER_PREFIX = 'impersonate:';

/** TTL du token impersonate à usage unique : 10 minutes. */
export const IMPERSONATION_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Durée de vie de la session JWT issue d'une impersonation : 1 heure.
 *
 * Volontairement BIEN plus courte que la session normale (90j, cf.
 * auth.config.ts). Une impersonation est une action de support ponctuelle ;
 * une session admin-as-user ne doit pas traîner indéfiniment.
 */
export const IMPERSONATION_SESSION_TTL_S = 60 * 60;

/** Claims ajoutés au JWT d'une session impersonée. */
export type ImpersonationClaims = {
  /** Toujours `true` sur une session issue d'une impersonation. */
  impersonated: true;
  /** Email du platform admin qui a déclenché l'impersonation (audit + UI bannière). */
  impersonatedBy: string;
};

/**
 * Détermine si le cookie de session doit utiliser le préfixe `__Secure-`.
 *
 * Auth.js l'active dès que l'URL du site est en HTTPS. On se cale sur la
 * même logique : tout sauf `http://` (typiquement localhost dev/test) →
 * cookie sécurisé. Le `salt` de chiffrement du JWT DOIT être identique au
 * nom du cookie (cf. @auth/core/jwt : `salt = cookieName`), sinon le JWT
 * encodé ici ne pourra pas être déchiffré par le middleware.
 */
export function useSecureCookies(): boolean {
  const url = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_SITE_URL || '';
  // Pas d'URL configurée → on suppose dev local (localhost) → non-secure.
  if (!url) return false;
  return !url.startsWith('http://');
}

/** Nom du cookie de session Auth.js, dépend du préfixe sécurisé. */
export function sessionCookieName(secure = useSecureCookies()): string {
  return secure ? '__Secure-authjs.session-token' : 'authjs.session-token';
}

/** Hash SHA-256 d'un token brut — ce qu'on stocke réellement en base. */
export function hashImpersonationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Comparaison timing-safe de deux hex digests de même longueur.
 * Les deux entrées sont des SHA-256 (64 hex chars) — longueurs égales par
 * construction, mais on garde le garde-fou défensif.
 */
export function tokenHashesEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export type CreatedImpersonationToken = {
  /** Token brut — à transmettre dans l'URL callback, JAMAIS persisté en clair. */
  rawToken: string;
  /** Date d'expiration absolue. */
  expires: Date;
};

/**
 * Génère un token impersonate, le stocke hashé dans `verification_tokens`
 * et retourne le token brut.
 *
 * @param prisma  Client Prisma.
 * @param targetUserId  `User.id` (cuid) de l'utilisateur à impersoner.
 */
export async function createImpersonationToken(
  prisma: PrismaClient,
  targetUserId: string
): Promise<CreatedImpersonationToken> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashImpersonationToken(rawToken);
  const expires = new Date(Date.now() + IMPERSONATION_TOKEN_TTL_MS);

  await prisma.verificationToken.create({
    data: {
      identifier: `${IMPERSONATION_IDENTIFIER_PREFIX}${targetUserId}`,
      token: tokenHash,
      expires,
    },
  });

  return { rawToken, expires };
}

export type ConsumeResult =
  | { ok: true; targetUserId: string }
  | { ok: false; reason: 'not_found' | 'expired' };

/**
 * Consomme un token impersonate : delete atomique (usage unique garanti) +
 * vérification d'expiration.
 *
 * `deleteMany` sur `(token = hash)` est atomique côté Postgres : si deux
 * requêtes courent en parallèle avec le même token, une seule obtient
 * `count: 1`, l'autre `count: 0` → pas de double consommation.
 *
 * On ne fait PAS confiance au `targetUserId` fourni par l'appelant : il est
 * dérivé de l'`identifier` de la row supprimée (la source de vérité).
 */
export async function consumeImpersonationToken(
  prisma: PrismaClient,
  rawToken: string
): Promise<ConsumeResult> {
  const tokenHash = hashImpersonationToken(rawToken);

  // Lecture pour récupérer l'identifier + l'expiry AVANT suppression.
  const row = await prisma.verificationToken.findUnique({
    where: { token: tokenHash },
  });
  if (!row || !row.identifier.startsWith(IMPERSONATION_IDENTIFIER_PREFIX)) {
    return { ok: false, reason: 'not_found' };
  }

  // Suppression atomique — garantit l'usage unique même en cas de course.
  const deleted = await prisma.verificationToken.deleteMany({
    where: { token: tokenHash },
  });
  if (deleted.count === 0) {
    // Une autre requête a consommé le token entre le find et le delete.
    return { ok: false, reason: 'not_found' };
  }

  if (row.expires.getTime() < Date.now()) {
    // Token trouvé mais périmé — déjà supprimé ci-dessus, donc plus
    // réutilisable. On signale quand même l'expiration à l'appelant.
    return { ok: false, reason: 'expired' };
  }

  const targetUserId = row.identifier.slice(IMPERSONATION_IDENTIFIER_PREFIX.length);
  return { ok: true, targetUserId };
}

export type ImpersonationJwtUser = {
  id: string;
  email: string | null;
  name?: string | null;
  image?: string | null;
};

/**
 * Encode un vrai JWT de session Auth.js pour le user ciblé, marqué
 * `impersonated`. Le résultat est la valeur à poser dans le cookie
 * `authjs.session-token`.
 *
 * La forme du payload reproduit ce que `auth.ts` attend :
 *  - `uid` lu par le callback `jwt` → recopié dans `session.user.id`
 *  - `sub` / `email` / `name` / `picture` : champs standard Auth.js
 *
 * @throws si `AUTH_SECRET` est absent — refus catégorique, pas de fallback.
 */
export async function encodeImpersonationSessionJwt(params: {
  user: ImpersonationJwtUser;
  impersonatedBy: string;
  secret?: string;
  secure?: boolean;
}): Promise<string> {
  const secret = params.secret ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required to issue an impersonation session');
  }
  const cookieName = sessionCookieName(params.secure);

  return encode({
    // salt DOIT être le nom du cookie — sinon le middleware ne pourra pas
    // déchiffrer le JWT (cf. @auth/core/jwt : `salt ?? cookieName`).
    salt: cookieName,
    secret,
    maxAge: IMPERSONATION_SESSION_TTL_S,
    token: {
      uid: params.user.id,
      sub: params.user.id,
      email: params.user.email,
      name: params.user.name ?? null,
      picture: params.user.image ?? null,
      impersonated: true,
      impersonatedBy: params.impersonatedBy,
    },
  });
}

/**
 * Détecte si une session (objet `session` Auth.js OU payload JWT brut) est
 * une session impersonée. Utilisé pour bloquer la ré-impersonation : un user
 * impersoné ne doit pas pouvoir relancer une impersonation.
 */
export function isImpersonatedSession(
  source: { impersonated?: unknown; user?: { impersonated?: unknown } } | null | undefined
): boolean {
  if (!source) return false;
  return source.impersonated === true || source.user?.impersonated === true;
}
