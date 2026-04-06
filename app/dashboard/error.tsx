'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log l'erreur en dev
    if (process.env.NODE_ENV === 'development') {
      console.error('[Dashboard Error]', error);
    }
  }, [error]);

  return (
    <div className="flex h-screen w-full items-center justify-center">
      <div className="max-w-md text-center space-y-4">
        <h2 className="text-2xl font-bold">Une erreur est survenue</h2>
        <p className="text-muted-foreground">
          {process.env.NODE_ENV === 'development' ? error.message : 'Veuillez réessayer.'}
        </p>
        {process.env.NODE_ENV === 'development' && error.stack && (
          <pre className="text-left text-xs bg-muted p-4 rounded-md overflow-auto max-h-64">
            {error.stack}
          </pre>
        )}
        <div className="flex gap-2 justify-center">
          <Button onClick={() => reset()}>Réessayer</Button>
          <Button variant="outline" onClick={() => window.location.href = '/dashboard'}>
            Recharger la page
          </Button>
        </div>
      </div>
    </div>
  );
}
