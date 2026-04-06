import { Metadata } from 'next';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { EnvProvider, EnvConfig } from '@/contexts/EnvContext';
import { PropsWithChildren, Suspense } from 'react';
import { getURL } from '@/utils/helpers';
import { GoogleTagManager, GoogleTagManagerNoScript } from '@/components/analytics/gtm';
import 'styles/main.css';
// Import fetch wrapper for Traefik routing in Docker
import '@/utils/fetch';

const defaultTitle = 'Veridian | Pilotez Twenty CRM & Notifuse en une plateforme';
const defaultDescription = 'Simplifiez votre business : connectez Twenty CRM et Notifuse sur Veridian. Automatisez votre marketing et gérez vos clients sans friction.';

const siteURL = getURL();

export const metadata: Metadata = {
  metadataBase: new URL(siteURL),
  title: {
    default: defaultTitle,
    template: '%s | Veridian'
  },
  description: defaultDescription,
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon',
  },
  openGraph: {
    title: defaultTitle,
    description: defaultDescription,
    siteName: 'Veridian',
    locale: 'fr_FR',
    type: 'website',
    url: siteURL,
    images: [{
      url: `${siteURL}/og.png`,
      width: 1200,
      height: 630,
      alt: 'Veridian - Plateforme Twenty CRM et Notifuse unifiée'
    }]
  },
  twitter: {
    card: 'summary_large_image',
    title: defaultTitle,
    description: defaultDescription,
    images: [`${siteURL}/og.png`]
  }
};

/**
 * ROOT LAYOUT with Runtime Environment Injection
 *
 * Ce layout s'applique à TOUTES les pages.
 * Il contient uniquement :
 * - HTML/body structure
 * - Styles globaux (main.css avec shadcn theme)
 * - <Toaster /> CRITIQUE : gère les notifications Supabase Auth
 * - Runtime ENV injection (window.__ENV__) pour Docker
 *
 * Les layouts spécifiques (marketing, dashboard) ajoutent leur propre UI.
 */
export default async function RootLayout({ children }: PropsWithChildren) {
  // 1. Capture environment variables from the Server (Docker Container)
  // This runs in Node.js where process.env is fully populated at RUNTIME
  const runtimeEnv: EnvConfig = {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || '',
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    NEXT_PUBLIC_TWENTY_URL: process.env.NEXT_PUBLIC_TWENTY_URL || '',
    NEXT_PUBLIC_NOTIFUSE_URL: process.env.NEXT_PUBLIC_NOTIFUSE_URL || '',
    NEXT_PUBLIC_NOTIFUSE_API_URL: process.env.NEXT_PUBLIC_NOTIFUSE_API_URL || '',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE || '',
    NEXT_PUBLIC_GTM_ID: process.env.NEXT_PUBLIC_GTM_ID || '',
  };

  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        {/* Preconnect hints pour optimiser le chargement des ressources externes */}
        <link rel="preconnect" href="https://cdn.supabase.com" />
        <link rel="preconnect" href="https://js.stripe.com" />
        <link rel="preconnect" href="https://www.googletagmanager.com" />

        {/* CRITICAL: Inject runtime env BEFORE any other script runs */}
        {/* This makes env vars available synchronously to ALL client-side code */}
        <script
          id="env-script"
          dangerouslySetInnerHTML={{
            __html: `window.__ENV__ = ${JSON.stringify(runtimeEnv)};`,
          }}
        />
      </head>
      <body className="antialiased">
        {/* Google Tag Manager (noscript) - Doit être juste après <body> */}
        <GoogleTagManagerNoScript />

        {/* Pass initialEnv to hydrate Context immediately (no fetch needed) */}
        <EnvProvider initialEnv={runtimeEnv}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
            <Suspense>
              {/* TOASTER : Affiche les messages d'erreur/succès depuis les query params */}
              {/* Utilisé par Supabase Auth - NE PAS SUPPRIMER */}
              <Toaster />
            </Suspense>
          </ThemeProvider>
        </EnvProvider>

        {/* Google Tag Manager Script */}
        <GoogleTagManager />
      </body>
    </html>
  );
}
