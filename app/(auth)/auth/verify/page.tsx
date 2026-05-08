'use client';

// Page legacy de vérification email Supabase OTP.
//
// Post-migration Auth.js v5 : le flow OTP email Supabase n'existe plus.
// - Le 2FA email opt-in passe par /auth/mfa (handler dédié)
// - Le reset password passe par /auth/reset (lien magique avec token)
//
// Cette page est conservée comme stub pour ne pas casser les anciens liens
// déjà envoyés par mail. Elle redirige selon le `type` query param :
// - type=recovery → /login (l'utilisateur doit redemander un reset)
// - sinon         → /dashboard (Auth.js gère la session)

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';

function VerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const type = searchParams.get('type');
    if (type === 'recovery') {
      router.replace('/signin/forgot_password?info=link_expired');
    } else {
      router.replace('/login');
    }
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary"></div>
          <p className="mt-4 text-sm text-muted-foreground">Redirection en cours...</p>
        </div>
      </Card>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
