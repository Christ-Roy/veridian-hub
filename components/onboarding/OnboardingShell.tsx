import type { ReactNode } from 'react';

import { AppTree } from '@/components/auth/AppTree';
import { VeridianHubLogo } from '@/components/icons/VeridianHubLogo';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Habillage commun à tous les écrans d'onboarding : même mise en page que
 * `/login` (formulaire à gauche, panneau de marque à droite) pour que la
 * première connexion d'un client ne ressemble pas à une page étrangère.
 *
 * Server Component : purement présentationnel, aucun état.
 */
export function OnboardingShell({
  children,
  /** Texte du panneau de marque, adapté à l'écran affiché. */
  brandBaseline = 'Votre espace Veridian est prêt. Il ne manque plus que vous.',
  className,
}: {
  children: ReactNode;
  brandBaseline?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'auth-screen flex min-h-screen w-full flex-col lg:flex-row',
        className,
      )}
    >
      {/* Colonne de gauche — le contenu de l'étape en cours */}
      <div className="flex flex-1 items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-center lg:hidden">
            <VeridianHubLogo size="md" />
          </div>

          <Card className="relief-card border p-6">{children}</Card>
        </div>
      </div>

      {/* Colonne de droite — panneau de marque (masqué sous lg) */}
      <div className="relief-card hidden items-center justify-center border-l border-border bg-card p-12 backdrop-blur-md lg:flex lg:w-1/2">
        <div className="flex flex-col items-center justify-center space-y-8 text-center">
          <VeridianHubLogo size="lg" />
          <p className="max-w-md text-lg text-muted-foreground">
            {brandBaseline}
          </p>
          <AppTree className="mt-2" />
        </div>
      </div>
    </div>
  );
}
