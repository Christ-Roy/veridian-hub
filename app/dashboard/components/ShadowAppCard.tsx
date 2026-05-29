'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ExternalLink } from 'lucide-react';
import type { AppMetadata } from '@/lib/pricing/plans';
import { AppIdentity, type AppKey } from './AppIdentity';

interface ShadowAppCardProps {
  app: AppMetadata;
}

// Résout la clé d'app (analytics / cms) vers le logo de marque AppIdentity
// — même style favicon .hub que les cards actives, fini les icônes génériques.
const SHADOW_APP_KEYS: Record<string, AppKey> = {
  analytics: 'analytics',
  cms: 'cms',
};

/**
 * Card "shadow marketing" pour apps client_only (Analytics, CMS) quand le
 * tenant n'a pas de plan lifetime_site_vitrine. Cf CONTRAT-HUB.md §8.9.
 *
 * État visuel : card "upsell" pleinement lisible (pas grisée, pas de cadenas)
 * avec badge "Offre site Veridian" — elle doit se lire comme une découverte,
 * pas comme une feature verrouillée (cf ticket onboarding §4). Au click,
 * Dialog explicatif (shadcn — focus trap, Escape, aria) + CTA vers
 * veridian.site/sites.
 */
export function ShadowAppCard({ app }: ShadowAppCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const appKey = SHADOW_APP_KEYS[app.key];

  return (
    <>
      <Card
        className="flex flex-col h-full cursor-pointer hover:shadow-md hover:border-primary/40 transition-all"
        onClick={() => setModalOpen(true)}
      >
        <CardHeader>
          <div className="flex items-center gap-3">
            {appKey && <AppIdentity app={appKey} />}
            <div>
              <CardTitle className="text-xl">{app.display_name}</CardTitle>
              <CardDescription className="mt-1">{app.tagline}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1">
          <div className="py-4 text-center text-sm text-muted-foreground">
            <p>Cet outil est <strong>inclus avec votre site web Veridian</strong>.</p>
            <p className="text-xs mt-2">Cliquez pour découvrir l&apos;offre.</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="outline" className="w-full" size="lg" onClick={(e) => { e.stopPropagation(); setModalOpen(true); }}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Découvrir les sites Veridian
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader className="items-center text-center">
            {appKey && <AppIdentity app={appKey} size="lg" className="mb-1" />}
            <DialogTitle>{app.display_name}</DialogTitle>
            <DialogDescription>{app.tagline}</DialogDescription>
          </DialogHeader>

          <Alert variant="warning">
            <AlertDescription>
              Cette application est <strong>incluse avec l&apos;achat d&apos;un site vitrine Veridian</strong>.
              Découvre nos offres clé en main pour entrepreneurs et TPE.
            </AlertDescription>
          </Alert>

          <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            <Button
              className="w-full"
              size="lg"
              onClick={() => {
                if (app.marketing_url) {
                  window.open(app.marketing_url, '_blank', 'noopener,noreferrer');
                }
                setModalOpen(false);
              }}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Voir les sites Veridian
            </Button>
            <Button variant="outline" className="w-full" onClick={() => setModalOpen(false)}>
              Fermer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
