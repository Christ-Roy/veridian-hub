'use client';

import { Button } from '@/components/ui/button';
import { createStripePortal } from '@/utils/stripe/server';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function StripePortalButton() {
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
    <Button onClick={handleClick} disabled={isLoading} className="w-fit">
      {isLoading ? 'Loading...' : 'Open Customer Portal'}
    </Button>
  );
}
