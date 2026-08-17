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
        // `min-h-screen` valait `100vh`, exactement le piège que l'autre
        // moitié de l'onboarding (la qualification) prend soin d'éviter :
        // sur mobile, `100vh` compte la barre d'adresse rétractée, donc
        // l'écran déborde et la page défile « sur du vide ». On aligne les
        // deux moitiés sur `dvh` avec zone défilante interne, pour que le
        // client qui enchaîne le mot de passe puis la qualification dans la
        // même minute ne change pas d'univers en route.
        'auth-screen flex h-screen w-full flex-col overflow-hidden supports-[height:100dvh]:h-[100dvh] lg:flex-row',
        'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {/* Colonne de gauche — le contenu de l'étape en cours. `min-h-0` +
          `overflow-y-auto` : le scroll vit ICI, jamais sur la page. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-contain p-6 lg:p-12">
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
