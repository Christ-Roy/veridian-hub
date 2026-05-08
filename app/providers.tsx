'use client';

/**
 * Wrapper Client Components qui rend la session Auth.js disponible via
 * `useSession()` dans toute l'arbre client.
 *
 * À monter dans `app/layout.tsx` au-dessus des composants qui consomment la
 * session (Navbar, AuthTracker, PurchaseTracker, formulaires, etc.).
 */

import { SessionProvider } from 'next-auth/react';

export default function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
