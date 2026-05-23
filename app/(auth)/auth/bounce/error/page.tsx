/**
 * /auth/bounce/error — page d'erreur dédiée Couche 4 (cf. CONTRAT-HUB §6bis.8.2).
 *
 * Affichée quand le bounce OAuth Hub→app a échoué pour une raison
 * infrastructure (5xx app, timeout, secret désync, ENV manquante).
 *
 * On affiche un message neutre côté user (pas d'exposition du code interne)
 * + CTA "Retour Veridian" pour éviter la boucle (cf. spec : "pas de loop").
 */

import Link from 'next/link';
import Logo from '@/components/icons/Logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface BounceErrorPageProps {
  searchParams: Promise<{ app?: string; code?: string }>;
}

export default async function BounceErrorPage({ searchParams }: BounceErrorPageProps) {
  const { app, code } = await searchParams;
  const safeApp = (app ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  const safeCode = (code ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  const displayApp = safeApp || 'l\'application';

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md border shadow-sm p-8 space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo width="48px" height="48px" />
          <h1 className="text-2xl font-bold">Impossible de revenir sur {displayApp}</h1>
          <p className="text-muted-foreground text-sm">
            Votre connexion Veridian a bien fonctionné, mais nous n'arrivons
            pas à vous rediriger vers {displayApp} pour le moment. Réessayez
            dans quelques instants.
          </p>
          {safeCode && (
            <p className="text-xs text-muted-foreground/70 font-mono">
              code: {safeCode}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <Button asChild>
            <Link href="/dashboard">Retour à mon dashboard</Link>
          </Button>
          <Button variant="outline" asChild>
            <a href="https://veridian.site">Aller sur veridian.site</a>
          </Button>
        </div>
      </Card>
    </div>
  );
}
