'use client';

/**
 * Bloc de connexion affiché en haut de la page `/invite/[token]` quand
 * l'invitee n'est pas encore connecté. Propose :
 *   - OAuth Google / Microsoft (gated par allowOauth — désactivé en staging
 *     Tailscale-only, cf. memory `feedback_oauth_pas_sur_staging_tailscale`).
 *   - Login email/password existant (retour sur /invite/[token] après auth).
 *   - "Créer un compte par email" (signup avec returnTo=/invite/[token]).
 *
 * Pre-remplit l'email du signup avec `invitee_email` quand connu pour
 * réduire la friction de l'onboarding.
 */

import { Button } from '@/components/ui/button';
import { GoogleIcon, MicrosoftIcon } from '@/components/auth/provider-icons';
import { signIn } from 'next-auth/react';
import Link from 'next/link';

interface Props {
  token: string;
  returnTo: string;
  inviteeEmail?: string;
  allowOauth: boolean;
}

export function InviteSignInOptions({ token, returnTo, inviteeEmail, allowOauth }: Props) {
  const callbackUrl = returnTo;
  const signupHref =
    `/signup?invite=${encodeURIComponent(token)}&callbackUrl=${encodeURIComponent(returnTo)}` +
    (inviteeEmail ? `&email=${encodeURIComponent(inviteeEmail)}` : '');
  const loginHref = `/login?callbackUrl=${encodeURIComponent(returnTo)}`;

  return (
    <div className="flex flex-col gap-3">
      {allowOauth ? (
        <>
          <Button
            variant="outline"
            type="button"
            className="w-full"
            onClick={() => signIn('google', { callbackUrl })}
            data-testid="invite-signin-google"
          >
            <span className="mr-2"><GoogleIcon /></span>
            Continuer avec Google
          </Button>
          <Button
            variant="outline"
            type="button"
            className="w-full"
            onClick={() => signIn('microsoft-entra-id', { callbackUrl })}
            data-testid="invite-signin-microsoft"
          >
            <span className="mr-2"><MicrosoftIcon /></span>
            Continuer avec Microsoft
          </Button>
          <div className="relative my-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-muted" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">ou</span>
            </div>
          </div>
        </>
      ) : null}
      <Button asChild className="w-full" data-testid="invite-signup-email">
        <Link href={signupHref}>Créer un compte par email</Link>
      </Button>
      <Button asChild variant="ghost" className="w-full" data-testid="invite-login-existing">
        <Link href={loginHref}>J&apos;ai déjà un compte</Link>
      </Button>
    </div>
  );
}
