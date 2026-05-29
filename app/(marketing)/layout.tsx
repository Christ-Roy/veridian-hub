import { PropsWithChildren } from 'react';

/**
 * MARKETING LAYOUT
 *
 * Le marketing est centralisé sur le site vitrine `veridian.site`. Le Hub ne
 * conserve sous ce groupe que :
 *  - `/` → redirige vers veridian.site (cf. page.tsx)
 *  - `/pricing` → tunnel de checkout Stripe (noindex, sans chrome)
 *  - `/privacy`, `/terms`, `/legal` → pages légales (exigées Google/Stripe)
 *
 * Plus de Navbar ni Footer : ces pages ne sont pas des pages vitrine. Les
 * pages légales portent leur propre mise en page.
 */
export default function MarketingLayout({ children }: PropsWithChildren) {
  return (
    <main id="skip" className="min-h-screen">
      {children}
    </main>
  );
}
