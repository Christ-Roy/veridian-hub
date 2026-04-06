import { SignupForm } from '@/components/auth/SignupForm';
import Logo from '@/components/icons/Logo';
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { getAuthTypes } from '@/utils/auth-helpers/settings';
import { Card } from '@/components/ui/card';

export default async function SignupPage() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    return redirect('/dashboard');
  }

  const { allowOauth, allowEmail } = getAuthTypes();

  return (
    <div className="min-h-screen w-full flex flex-col lg:flex-row">
      {/* Left side - Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 bg-background">
        <div className="w-full max-w-sm">
          {/* Logo en haut sur mobile, caché sur desktop */}
          <div className="flex justify-center lg:hidden mb-6">
            <a href="/" className="flex items-center gap-2 font-medium">
              <Logo width="32px" height="32px" />
              <span className="text-lg font-semibold text-foreground">Veridian</span>
            </a>
          </div>

          {/* Formulaire dans une Card avec bordure */}
          <Card className="border shadow-sm p-6">
            <SignupForm allowEmail={allowEmail} allowOauth={allowOauth} />
          </Card>
        </div>
      </div>

      {/* Right side - Brand - 50% sur lg screens */}
      <div className="hidden lg:flex lg:w-1/2 bg-muted items-center justify-center p-12">
        <div className="flex flex-col items-center justify-center text-center space-y-8">
          {/* Logo desktop */}
          <a href="/" className="flex items-center gap-4 absolute top-12 left-12">
            <Logo width="32px" height="32px" />
            <span className="text-lg font-semibold text-foreground">Veridian</span>
          </a>

          <div className="flex items-center gap-4">
            <Logo width="80px" height="80px" />
            <span className="text-6xl font-bold tracking-tight text-foreground">Veridian</span>
          </div>
          <p className="text-xl text-muted-foreground max-w-md">
            Rejoignez Veridian et boostez votre productivité
          </p>
        </div>
      </div>
    </div>
  );
}
