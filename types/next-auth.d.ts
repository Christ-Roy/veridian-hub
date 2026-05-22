/**
 * Augmentation des types Auth.js v5 pour le Hub.
 *
 * - `Session.user.id` : recopié depuis `token.uid` dans le callback `session`
 *   (cf. auth.ts) — déjà utilisé partout, on le déclare proprement ici.
 * - `Session.user.impersonated` / `impersonatedBy` : posés quand la session
 *   provient d'une impersonation admin (cf. lib/auth/impersonation.ts).
 * - `JWT.uid` / `JWT.impersonated` / `JWT.impersonatedBy` : claims portés
 *   par le JWT de session.
 */

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id?: string;
      /** `true` si la session provient d'une impersonation admin. */
      impersonated?: boolean;
      /** Email du platform admin à l'origine de l'impersonation, sinon null. */
      impersonatedBy?: string | null;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    /** `true` sur un JWT issu d'une impersonation admin. */
    impersonated?: boolean;
    /** Email du platform admin à l'origine de l'impersonation. */
    impersonatedBy?: string | null;
  }
}
