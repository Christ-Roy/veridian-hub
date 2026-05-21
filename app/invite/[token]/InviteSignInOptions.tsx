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
import { signIn } from 'next-auth/react';
import Link from 'next/link';

function GoogleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 23" width="18" height="18" aria-hidden="true">
      <path fill="#f25022" d="M1 1h10v10H1z"/>
      <path fill="#7fba00" d="M12 1h10v10H12z"/>
      <path fill="#00a4ef" d="M1 12h10v10H1z"/>
      <path fill="#ffb900" d="M12 12h10v10H12z"/>
    </svg>
  );
}

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
