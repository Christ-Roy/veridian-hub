'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { CHEMINS_SANS_GTM, estCheminSensible } from '@/lib/gtm';

export { CHEMINS_SANS_GTM, estCheminSensible } from '@/lib/gtm';

/**
 * Chemins dont l'URL porte un SECRET, et sur lesquels GTM ne doit jamais
 * être monté.
 *
 * Le tag GA4 d'un container GTM envoie par défaut `page_location =
 * location.href`, query string ET segments de chemin compris. Sur
 * `/auth/reset?token=<32 octets hex>`, le jeton de réinitialisation partait
 * donc chez Google, où il restait lisible par quiconque a accès à la
 * propriété (rapports de pages, export BigQuery, DebugView).
 *
 * (Le Referer, lui, ne fuit que l'origine : la policy navigateur par défaut
 * `strict-origin-when-cross-origin` s'en charge. C'est bien `page_location`,
 * lu en JS, qui fuyait.)
 *
 * Règle : tout écran qui consomme un jeton entre ici AVANT d'exister.
 * `/onboard` est listé par avance — le flow de première connexion prévoit un
 * lien à 30 jours, donc un secret bien plus juteux qu'un reset à 1 h.
 */
export function GoogleTagManager() {
  const gtmId = process.env.NEXT_PUBLIC_GTM_ID;
  const pathname = usePathname();

  const sensible = estCheminSensible(pathname);

  useEffect(() => {
    if (gtmId && !sensible && typeof window !== 'undefined') {
      // Push dataLayer pour initialiser GTM
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        'gtm.start': new Date().getTime(),
        event: 'gtm.js'
      });
    }
  }, [gtmId, sensible]);

  // Le jeton est dans l'URL : aucun tag ne doit être chargé sur cet écran.
  if (sensible) return null;

  if (!gtmId) {
    console.error('[GTM] GTM_ID is missing! Component will not render.');
    return null;
  }

  return (
    <>
      {/* Google Tag Manager Script */}
      <Script
        id="gtm-script"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
            new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
            j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
            'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
            })(window,document,'script','dataLayer','${gtmId}');
          `,
        }}
      />
    </>
  );
}

export function GoogleTagManagerNoScript() {
  const gtmId = process.env.NEXT_PUBLIC_GTM_ID;
  const pathname = usePathname();

  // Même exclusion que le script : l'iframe ne fuit que l'origine via le
  // Referer, mais on ne laisse aucun tag tiers sur un écran à secret.
  if (estCheminSensible(pathname)) return null;

  if (!gtmId) {
    console.error('[GTM NoScript] GTM_ID is missing! NoScript iframe will not render.');
    return null;
  }

  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${gtmId}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
      />
    </noscript>
  );
}

// Types pour TypeScript
declare global {
  interface Window {
    dataLayer: any[];
  }
}
