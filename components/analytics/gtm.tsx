'use client';

import { useEffect } from 'react';
import Script from 'next/script';

export function GoogleTagManager() {
  const gtmId = process.env.NEXT_PUBLIC_GTM_ID;

  console.log('[GTM] Google Tag Manager component loaded');
  console.log('[GTM] GTM_ID from env:', gtmId);
  console.log('[GTM] All NEXT_PUBLIC env vars:', Object.keys(process.env).filter(key => key.startsWith('NEXT_PUBLIC')));

  useEffect(() => {
    if (gtmId && typeof window !== 'undefined') {
      console.log('[GTM] Initializing dataLayer with GTM ID:', gtmId);
      // Push dataLayer pour initialiser GTM
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        'gtm.start': new Date().getTime(),
        event: 'gtm.js'
      });
      console.log('[GTM] DataLayer initialized:', window.dataLayer);
    } else {
      console.warn('[GTM] Cannot initialize - gtmId:', gtmId, 'window:', typeof window);
    }
  }, [gtmId]);

  if (!gtmId) {
    console.error('[GTM] GTM_ID is missing! Component will not render.');
    return null;
  }

  console.log('[GTM] Rendering GTM script tag with ID:', gtmId);

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

  console.log('[GTM NoScript] GTM_ID:', gtmId);

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
