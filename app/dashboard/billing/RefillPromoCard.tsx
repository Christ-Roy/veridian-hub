import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Target } from 'lucide-react';

/**
 * Panel "Acheter des leads Prospection" sur `/dashboard/billing`.
 *
 * Affiche uniquement si l'user a au moins un tenant Prospection provisionné.
 * Pas de balance affichée (la balance est stockée côté Prospection app, pas
 * dans le schéma Hub — décision ticket #24 Q1). Si Robert veut un compteur
 * plus tard, c'est un endpoint Prospection HMAC à câbler.
 *
 * CTA vers `/dashboard/refill-leads` (livré BUILD #9) qui rend le flow
 * complet slider + checkout Stripe.
 */
export function RefillPromoCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Target className="h-5 w-5 text-primary" />
          <div>
            <CardTitle>Acheter des leads</CardTitle>
            <CardDescription>
              Crédite ton workspace Prospection en leads ciblés, à vie.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Slider de 1 à 100 000 leads, tarif dégressif selon ton plan.
        </p>
        <Button asChild>
          <Link href="/dashboard/refill-leads">Acheter des leads</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
