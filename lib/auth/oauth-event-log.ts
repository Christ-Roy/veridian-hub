/**
 * Audit log des connexions OAuth — append une row dans
 * `hub_app.oauth_signin_events`.
 *
 * Câblé sur les deux issues d'un flow OAuth, depuis `auth.ts` :
 *   - succès : event `signIn` Auth.js v5 → `recordOauthSuccess`
 *   - échec  : override `logger.error` Auth.js (OAuthCallbackError /
 *     Configuration / OAuthSignInError) → `recordOauthFailure`
 *
 * Best-effort, comme `lib/admin/audit-log.ts` : un échec d'écriture ne doit
 * JAMAIS faire échouer le login (un user ne doit pas être bloqué parce que
 * la table d'audit est indisponible). On log l'erreur en JSON stderr et on
 * swallow l'exception.
 *
 * Périmètre volontairement minimal : ce module N'ALTÈRE PAS le flow OAuth,
 * il ne fait qu'observer. Aucun retour de valeur exploité par Auth.js.
 *
 * Factorisé en pure functions injectables (deps Prisma + logger) pour les
 * tester unitairement sans monter une instance NextAuth — même pattern que
 * `sign-in-callback.ts` et `create-user-event.ts`.
 */

import type { PrismaClient } from '@prisma/client';

/** Sous-ensemble Prisma minimal — mockable en test. */
type OauthEventPrisma = {
  oauthSigninEvent: Pick<PrismaClient['oauthSigninEvent'], 'create'>;
};

type Logger = { error: (...args: unknown[]) => void };

export type OauthEventDeps = {
  prisma: OauthEventPrisma;
  /** Logger (mockable) — par défaut console. */
  logger?: Logger;
};

/** Champs communs aux events succès / échec. */
type OauthEventContext = {
  /** IP du caller (cf. extractClientIp). Optionnel — peut manquer hors request. */
  ip?: string | null;
  /** User-Agent du caller. Optionnel. */
  userAgent?: string | null;
  /** Durée du flow OAuth en ms, si mesurée. Optionnel. */
  durationMs?: number | null;
};

export type OauthSuccessInput = OauthEventContext & {
  /** Provider id Auth.js : 'google', 'microsoft-entra-id', 'mock-oauth'... */
  provider: string;
  /** Email résolu du user. */
  email?: string | null;
};

export type OauthFailureInput = OauthEventContext & {
  /** Provider id si connu, sinon 'unknown'. */
  provider?: string | null;
  /** Email si connu au moment de l'échec (souvent null). */
  email?: string | null;
  /** Code d'erreur Auth.js : 'OAuthCallbackError', 'Configuration'... */
  errorCode?: string | null;
};

/** Borne défensive : Postgres TEXT est illimité mais on évite de stocker
 *  un User-Agent forgé de 100 Ko. 1 Ko couvre tous les UA réels. */
function clamp(value: string | null | undefined, max = 1024): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Construit le logger d'events OAuth. Retourne deux fonctions best-effort.
 */
export function createOauthEventLogger({ prisma, logger = console }: OauthEventDeps) {
  /** Append une row d'audit, en swallow toute erreur. */
  async function write(data: {
    event: 'success' | 'failure';
    provider: string;
    email: string | null;
    ip: string | null;
    userAgent: string | null;
    errorCode: string | null;
    durationMs: number | null;
  }): Promise<void> {
    try {
      await prisma.oauthSigninEvent.create({ data });
    } catch (err) {
      // Best-effort : on ne casse jamais le login sur un échec d'audit.
      logger.error(
        JSON.stringify({
          tag: '[oauth-event-log-failed]',
          level: 'error',
          event: data.event,
          provider: data.provider,
          error: err instanceof Error ? err.message : String(err),
          ts: new Date().toISOString(),
        }),
      );
    }
  }

  return {
    /** Trace un login OAuth réussi. */
    recordOauthSuccess(input: OauthSuccessInput): Promise<void> {
      return write({
        event: 'success',
        provider: input.provider || 'unknown',
        email: clamp(input.email),
        ip: clamp(input.ip),
        userAgent: clamp(input.userAgent),
        errorCode: null,
        durationMs: input.durationMs ?? null,
      });
    },

    /** Trace un échec de login OAuth. */
    recordOauthFailure(input: OauthFailureInput): Promise<void> {
      return write({
        event: 'failure',
        provider: input.provider || 'unknown',
        email: clamp(input.email),
        ip: clamp(input.ip),
        userAgent: clamp(input.userAgent),
        errorCode: clamp(input.errorCode, 128),
        durationMs: input.durationMs ?? null,
      });
    },
  };
}

export type OauthEventLogger = ReturnType<typeof createOauthEventLogger>;
