import { PropsWithChildren } from 'react';

/**
 * AUTH LAYOUT
 *
 * Layout pour les pages d'authentification (signin, signup).
 * Design simple et centré, pas de sidebar ni navbar.
 *
 * Utilisé pour :
 * - /signin
 * - /signin1 (version shadcn)
 * - /signup
 * - /auth/callback
 * - /auth/reset_password
 */
export default function AuthLayout({ children }: PropsWithChildren) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      {children}
    </div>
  );
}
