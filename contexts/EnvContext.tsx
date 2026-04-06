'use client';

import { createContext, useContext, useState, PropsWithChildren } from 'react';

/**
 * Type pour la configuration publique de l'environnement
 */
export type EnvConfig = {
  NEXT_PUBLIC_SITE_URL: string;
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  NEXT_PUBLIC_TWENTY_URL: string;
  NEXT_PUBLIC_NOTIFUSE_URL: string;
  NEXT_PUBLIC_NOTIFUSE_API_URL: string;
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: string;
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE: string;
  NEXT_PUBLIC_GTM_ID: string;
};

/**
 * Declare global window.__ENV__ for TypeScript
 */
declare global {
  interface Window {
    __ENV__: EnvConfig;
  }
}

/**
 * Valeurs par défaut depuis le build-time (fallback)
 */
const buildTimeEnv: EnvConfig = {
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

/**
 * Context pour les variables d'environnement runtime
 */
const EnvContext = createContext<EnvConfig>(buildTimeEnv);

/**
 * Universal helper to get environment variables.
 * Works in:
 * 1. Browser (runtime injection via window.__ENV__)
 * 2. Server (process.env)
 * 3. Local Dev (process.env via buildTimeEnv)
 *
 * This is the PREFERRED way to access env vars outside React components.
 */
export function getEnv(key: keyof EnvConfig): string {
  if (typeof window !== 'undefined') {
    return window.__ENV__?.[key] || buildTimeEnv[key];
  }
  return buildTimeEnv[key];
}

interface EnvProviderProps extends PropsWithChildren {
  /**
   * Server-injected environment variables.
   * Passed from layout.tsx to hydrate context immediately (no fetch).
   */
  initialEnv?: EnvConfig;
}

/**
 * Provider that exposes runtime environment variables to React tree.
 *
 * ARCHITECTURE: Server-Side Injection with Window Fallback
 * 1. Server reads process.env in layout.tsx (Docker runtime)
 * 2. Server injects window.__ENV__ via <script> tag (synchronous, no race condition)
 * 3. Server passes initialEnv prop to Provider (React hydration)
 * 4. Client Components can use window.__ENV__ OR useEnv() hook
 *
 * This eliminates the async fetch() race condition where Supabase client
 * initializes before useEffect() completes.
 */
export function EnvProvider({ children, initialEnv }: EnvProviderProps) {
  // Initialize state from server prop, window (if already hydrated), or build fallback
  const [env] = useState<EnvConfig>(() => {
    if (initialEnv) return initialEnv;
    if (typeof window !== 'undefined' && window.__ENV__) return window.__ENV__;
    return buildTimeEnv;
  });

  return <EnvContext.Provider value={env}>{children}</EnvContext.Provider>;
}

/**
 * Hook pour accéder aux variables d'environnement runtime
 *
 * Use this inside React components that need env vars.
 * For non-component code (utils, services), use getEnv() instead.
 *
 * @example
 * ```tsx
 * const { NEXT_PUBLIC_SUPABASE_URL } = useEnv();
 * ```
 */
export function useEnv(): EnvConfig {
  const context = useContext(EnvContext);
  if (!context) {
    throw new Error('useEnv must be used within EnvProvider');
  }
  return context;
}
