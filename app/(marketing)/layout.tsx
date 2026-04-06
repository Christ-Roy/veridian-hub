import Footer from '@/components/ui/Footer';
import Navbar from '@/components/ui/Navbar';
import { PropsWithChildren } from 'react';

/**
 * MARKETING LAYOUT
 *
 * Layout pour les pages marketing (homepage, pricing, account).
 * Contient Navbar (avec logique auth) et Footer.
 *
 * Utilisé pour :
 * - / (homepage)
 * - /account (gestion compte Stripe)
 *
 * Logique conservée :
 * - <Navbar /> : Récupère user via Supabase, affiche Sign In/Sign Out
 * - <Footer /> : Liens statiques et branding
 */
export default function MarketingLayout({ children }: PropsWithChildren) {
  return (
    <div className="flex flex-col min-h-screen bg-background">
      <Navbar />
      <main
        id="skip"
        className="flex-1 min-h-screen-navbar"
      >
        {children}
      </main>
      <Footer />
    </div>
  );
}
