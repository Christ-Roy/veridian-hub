import { PropsWithChildren } from 'react';

/**
 * AUTH LAYOUT
 *
 * Layout pour les pages d'authentification (login, signup).
 * Design simple et centré, pas de sidebar ni navbar.
 *
 * Utilisé pour :
 * - /login
 * - /signup
 * - /auth/reset
 * - /auth/verify
 */
export default function AuthLayout({ children }: PropsWithChildren) {
  return (
    <>{children}</>
  );
}
