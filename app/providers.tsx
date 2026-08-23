'use client';

/**
 * Wrapper Client Components qui rend la session Auth.js disponible via
 * `useSession()` dans toute l'arbre client.
 *
 * À monter dans `app/layout.tsx` au-dessus des composants qui consomment la
 * session (Navbar, AuthTracker, PurchaseTracker, formulaires, etc.).
 */

import { SessionProvider } from 'next-auth/react';
import { usePathname } from 'next/navigation';

export default function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Les ateliers /dev utilisent exclusivement des données fictives. Ne pas
  // monter Auth.js ici évite un appel /api/auth/session inutile et bruyant
  // quand le serveur local n'a volontairement aucun secret d'authentification.
  if (pathname === '/dev' || pathname.startsWith('/dev/')) {
    return <>{children}</>;
  }

  return <SessionProvider>{children}</SessionProvider>;
}
