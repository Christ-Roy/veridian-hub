'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription } from '@/components/ui/field';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { GoogleIcon, MicrosoftIcon } from '@/components/auth/provider-icons';

/**
 * Boutons OAuth partagés (Google + Microsoft) — extraits de LoginForm et
 * SignupForm qui dupliquaient à l'identique les SVG de marque et les handlers
 * `signIn(...)`.
 *
 * Les icônes viennent du module partagé `provider-icons.tsx` (source unique
 * avec `aria-hidden="true"` — le label texte porte le sens). Les couleurs
 * sont les couleurs officielles des marques Google / Microsoft et ne
 * relèvent PAS du design system Veridian.
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
          <GoogleIcon />
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
          <MicrosoftIcon />
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
