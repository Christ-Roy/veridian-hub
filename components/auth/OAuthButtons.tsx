'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription } from '@/components/ui/field';
import Link from 'next/link';
import { signIn } from 'next-auth/react';

/**
 * Boutons OAuth partagés (Google + Microsoft) — extraits de LoginForm et
 * SignupForm qui dupliquaient à l'identique les SVG de marque et les handlers
 * `signIn(...)`. Les couleurs des SVG sont les couleurs officielles des marques
 * Google / Microsoft — elles ne relèvent pas du design system Veridian et
 * doivent rester telles quelles.
 *
 * `footer` rend la ligne "Pas encore de compte ? / Déjà un compte ?" qui
 * diffère entre login et signup.
 */
export interface OAuthButtonsProps {
  /** URL de redirection après login OAuth réussi. */
  callbackUrl: string;
  /** Lien affiché sous les boutons (ex: vers /signup ou /login). */
  footer?: React.ReactNode;
}

export function OAuthButtons({ callbackUrl, footer }: OAuthButtonsProps) {
  return (
    <>
      <Field>
        <Button
          variant="outline"
          type="button"
          className="w-full"
          onClick={() => signIn('google', { callbackUrl })}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continuer avec Google
        </Button>
      </Field>
      <Field>
        <Button
          variant="outline"
          type="button"
          className="w-full"
          onClick={() => signIn('microsoft-entra-id', { callbackUrl })}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 23" width="18" height="18">
            <path fill="#f25022" d="M1 1h10v10H1z"/>
            <path fill="#7fba00" d="M12 1h10v10H12z"/>
            <path fill="#00a4ef" d="M1 12h10v10H1z"/>
            <path fill="#ffb900" d="M12 12h10v10H12z"/>
          </svg>
          Continuer avec Microsoft
        </Button>
        {footer && (
          <FieldDescription className="text-center">{footer}</FieldDescription>
        )}
      </Field>
    </>
  );
}

/** Lien "Pas encore de compte ? Créer un compte" — variante signup. */
export function SignupLink() {
  return (
    <>
      Pas encore de compte ?{' '}
      <Link href="/signup" className="underline underline-offset-4">
        Créer un compte
      </Link>
    </>
  );
}

/** Lien "Déjà un compte ? Se connecter" — variante login. */
export function LoginLink() {
  return (
    <>
      Déjà un compte ?{' '}
      <Link href="/login" className="underline underline-offset-4">
        Se connecter
      </Link>
    </>
  );
}
