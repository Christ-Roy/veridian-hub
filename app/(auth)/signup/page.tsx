import { SignupForm } from '@/components/auth/SignupForm';
import { GoogleOneTap } from '@/components/auth/GoogleOneTap';
import { VeridianHubLogo } from '@/components/icons/VeridianHubLogo';
import { AppTree } from '@/components/auth/AppTree';
import { redirect } from 'next/navigation';
import { getAuthTypes } from '@/utils/auth-helpers/settings';
import { Card } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/auth/get-user';

export default async function SignupPage() {
  // Auth.js v5 : si déjà loggué, redirect vers dashboard
  const user = await getCurrentUser();
  if (user) {
    return redirect('/dashboard');
  }

  const { allowOauth, allowEmail } = getAuthTypes();

  return (
    <div className="auth-screen min-h-screen w-full flex flex-col lg:flex-row">
      {/* Google One Tap : popup auto-login en complément du bouton OAuth
          classique. Aucun markup rendu, se gate lui-même. */}
      <GoogleOneTap callbackUrl="/dashboard" context="signup" />

      {/* Left side - Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-sm">
          {/* Logo en haut sur mobile, caché sur desktop */}
          <div className="flex justify-center lg:hidden mb-6">
            <VeridianHubLogo size="md" href="/" />
          </div>

          {/* Formulaire dans une Card avec bordure */}
          <Card className="border shadow-sm p-6">
            <SignupForm allowEmail={allowEmail} allowOauth={allowOauth} />
          </Card>
        </div>
      </div>

      {/* Right side - Brand - 50% sur lg screens */}
      <div className="hidden lg:flex lg:w-1/2 bg-card backdrop-blur-md border-l border-border items-center justify-center p-12">
        <div className="flex flex-col items-center justify-center text-center space-y-8">
          <VeridianHubLogo size="lg" />
          <p className="text-lg text-muted-foreground max-w-md">
            Rejoignez Veridian et boostez votre productivité
          </p>
          <AppTree className="mt-2" />
        </div>
      </div>
    </div>
  );
}
