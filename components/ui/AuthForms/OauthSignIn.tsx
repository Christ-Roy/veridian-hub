'use client';

import { Button } from '@/components/ui/button';
import { signIn } from 'next-auth/react';
import { useState } from 'react';

/**
 * OauthSignIn — Auth.js v5
 *
 * Bouton login OAuth. Seul Google est branché côté serveur (cf auth.config.ts).
 * On garde un tableau pour pouvoir en ajouter plus tard sans toucher au markup.
 */

type OAuthProvider = {
  id: string;
  displayName: string;
  icon: JSX.Element;
};

function GoogleIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.12A6.6 6.6 0 0 1 5.5 12c0-.74.13-1.46.34-2.12V7.04H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.96l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.04l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

const OAUTH_PROVIDERS: OAuthProvider[] = [
  {
    id: 'google',
    displayName: 'Google',
    icon: <GoogleIcon />,
  },
];

export default function OauthSignIn() {
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);

  const handleClick = async (providerId: string) => {
    setLoadingProvider(providerId);
    try {
      await signIn(providerId, { callbackUrl: '/dashboard' });
    } catch {
      // signIn redirige normalement, on ne devrait pas arriver ici
      setLoadingProvider(null);
    }
  };

  return (
    <div className="mt-8">
      {OAUTH_PROVIDERS.map((provider) => (
        <div key={provider.id} className="pb-2">
          <Button
            variant="slim"
            type="button"
            className="w-full"
            loading={loadingProvider === provider.id}
            onClick={() => handleClick(provider.id)}
          >
            <span className="mr-2">{provider.icon}</span>
            <span>Continue with {provider.displayName}</span>
          </Button>
        </div>
      ))}
    </div>
  );
}
