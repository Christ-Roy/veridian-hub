import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Target } from 'lucide-react';

/**
 * État vide quand le user n'a pas (encore) de tenant Prospection provisionné.
 * Renvoie vers /dashboard pour démarrer Prospection.
 */
export function EmptyRefillState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center text-center gap-4 py-12">
        <div className="rounded-full bg-primary/10 p-4">
          <Target className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-2 max-w-md">
          <h2 className="text-xl font-semibold">Prospection pas encore activé</h2>
          <p className="text-muted-foreground">
            L&apos;achat de leads est réservé aux workspaces Prospection. Démarre
            l&apos;essai gratuit pour activer ton workspace.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard">Activer Prospection</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
