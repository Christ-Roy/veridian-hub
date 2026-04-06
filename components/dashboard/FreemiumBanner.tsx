'use client';

import { useEffect, useState } from 'react';
import { XIcon } from 'lucide-react';
import Link from 'next/link';

interface FreemiumBannerProps {
  userCreatedAt: string;
  hasActiveSubscription: boolean;
}

export function FreemiumBanner({ userCreatedAt, hasActiveSubscription }: FreemiumBannerProps) {
  const [daysRemaining, setDaysRemaining] = useState<number | null>(null);
  const [hoursRemaining, setHoursRemaining] = useState<number>(0);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    // Marquer comme client-side pour éviter hydration mismatch
    setIsClient(true);

    if (process.env.NODE_ENV === 'development') {
      console.log('[FreemiumBanner] Props:', { userCreatedAt, hasActiveSubscription });
    }

    // Ne rien afficher si l'utilisateur a déjà un abonnement actif
    if (hasActiveSubscription) {
      if (process.env.NODE_ENV === 'development') {
        console.log('[FreemiumBanner] User has active subscription - hiding banner');
      }
      return;
    }

    // Calculer les jours restants du freemium
    const createdDate = new Date(userCreatedAt);
    const now = new Date();
    const diffTime = now.getTime() - createdDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    const remaining = 15 - diffDays;

    setDaysRemaining(remaining);
    setHoursRemaining(24 - diffHours);

    if (process.env.NODE_ENV === 'development') {
      console.log('[FreemiumBanner] Calculated:', {
        diffDays,
        diffHours,
        remaining,
        createdDate: createdDate.toISOString()
      });
    }

    // Mettre à jour chaque minute
    const interval = setInterval(() => {
      const now = new Date();
      const diffTime = now.getTime() - createdDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      const diffHours = Math.floor((diffTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

      const remaining = 15 - diffDays;

      setDaysRemaining(remaining);
      setHoursRemaining(24 - diffHours);
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [userCreatedAt, hasActiveSubscription]);

  // Ne pas afficher le banner si :
  // - L'utilisateur a un abonnement actif
  // - La période freemium est expirée
  // - Le banner a été fermé manuellement
  // - Pas encore monté côté client (hydration)
  if (!isClient || hasActiveSubscription || daysRemaining === null || daysRemaining < 0 || isDismissed) {
    return null;
  }

  return (
    <div className="freemium-banner text-foreground">
      <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
        {/* Message principal */}
        <div className="flex items-center gap-3 flex-1">
          <div className="flex items-center gap-2">
            {/* Badge avec compte à rebours */}
            <div className="bg-primary text-primary-foreground px-3 py-1 rounded-md font-bold text-sm">
              {daysRemaining === 0 ? (
                `${hoursRemaining}h restantes`
              ) : (
                `${daysRemaining} jour${daysRemaining > 1 ? 's' : ''} restant${daysRemaining > 1 ? 's' : ''}`
              )}
            </div>
            <span className="text-sm">
              de votre période d'essai gratuite
            </span>
          </div>
        </div>

        {/* CTA */}
        <div className="flex items-center gap-3">
          <Link
            href="/pricing"
            className="bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium text-sm hover:bg-primary/90 transition-colors"
          >
            Choisir un plan
          </Link>

          {/* Bouton fermer */}
          <button
            onClick={() => setIsDismissed(true)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            aria-label="Fermer le bandeau"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Barre de progression */}
      <div className="absolute bottom-0 left-0 w-full h-0.5 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-1000"
          style={{ width: `${(daysRemaining / 15) * 100}%` }}
        />
      </div>
    </div>
  );
}
