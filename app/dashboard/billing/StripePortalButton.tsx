'use client';

import { Button } from '@/components/ui/button';
import { createStripePortal } from '@/utils/stripe/server';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ComponentProps } from 'react';

interface StripePortalButtonProps {
  /** Libellé du bouton au repos (par défaut "Ouvrir le portail client"). */
  label?: string;
  /** Variant shadcn du bouton (par défaut "default"). */
  variant?: ComponentProps<typeof Button>['variant'];
  /** Classe additionnelle sur le bouton. */
  className?: string;
}

/**
 * Bouton qui ouvre une session Stripe Billing Portal pour le user courant.
 *
 * Le portail Stripe ouvre sur l'overview, qui donne un accès direct à la
 * méthode de paiement et aux factures — c'est suffisant pour le CTA dunning
 * (`past_due`). Le libellé et le variant sont paramétrables pour que la même
 * action serve d'un CTA neutre ("Gérer mon abonnement") ou d'urgence
 * ("Mettre à jour ma carte"). La server action `createStripePortal` reste
 * inchangée — propriété de la lib Stripe.
 */
export function StripePortalButton({
  label = 'Ouvrir le portail client',
  variant = 'default',
  className = 'w-fit',
}: StripePortalButtonProps = {}) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleClick = async () => {
    setIsLoading(true);
    try {
      const url = await createStripePortal('/dashboard/billing');
      router.push(url);
    } catch (error) {
      console.error('Failed to create portal session:', error);
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleClick}
      disabled={isLoading}
      variant={variant}
      className={className}
    >
      {isLoading ? 'Chargement…' : label}
    </Button>
  );
}
