import { notFound } from 'next/navigation';
import Link from 'next/link';

import { prisma } from '@/lib/prisma';
import { getOnboardingInviteByToken } from '@/lib/onboarding/service';
import { OnboardClient } from './OnboardClient';
import { OnboardingScreen } from '@/components/onboarding/OnboardingScreen';
import type { OnboardingInvite } from '@/components/onboarding/types';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMPTY_INVITE: OnboardingInvite = {
  email: 'client@exemple.fr',
  workspaceName: 'Votre espace Veridian',
  invitedBy: 'Veridian',
  apps: [],
  expiresAt: new Date().toISOString(),
};

export default async function OnboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const lookup = await getOnboardingInviteByToken(prisma, token);

  if (!lookup.ok) {
    if (lookup.code === 'invalid') notFound();
    if (lookup.code === 'activated') {
      return (
        <OnboardingShell brandBaseline="Votre accès est déjà actif. Direction votre espace.">
          <Card className="border-0 p-0 shadow-none">
            <div className="flex flex-col gap-5 text-center">
              <div>
                <h1 className="text-2xl font-bold">Ce lien a déjà été utilisé</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Votre compte Veridian est actif. Connectez-vous avec le mot de passe choisi pendant l’activation.
                </p>
              </div>
              <Button asChild className="w-full">
                <Link href="/login">Aller à la connexion</Link>
              </Button>
            </div>
          </Card>
        </OnboardingShell>
      );
    }
    return (
      <OnboardingScreen
        state={lookup.code === 'expired' ? 'token-expire' : 'erreur'}
        invite={EMPTY_INVITE}
        steps={[]}
      />
    );
  }

  return <OnboardClient token={token} invite={lookup.invite} />;
}
