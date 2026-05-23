'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import {
  ExternalLink,
  Sparkles,
  BarChart3,
  FileText,
  AppWindow,
  type LucideIcon,
} from 'lucide-react';
import type { AppMetadata } from '@/lib/pricing/plans';

interface ShadowAppCardProps {
  app: AppMetadata;
}

// Les apps client_only portent un emoji dans AppMetadata (lib/pricing/plans.ts,
// hors périmètre). On le résout en icône lucide ici pour rester cohérent avec
// le pattern conteneur tinté des autres cards du dashboard (ServiceCard,
// ProspectionCard, TenantCard).
const APP_ICONS: Record<string, LucideIcon> = {
  analytics: BarChart3,
  cms: FileText,
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
  const Icon = APP_ICONS[app.key] ?? AppWindow;

  return (
    <>
      <Card
        className="cursor-pointer hover:shadow-md hover:border-primary/40 transition-all"
        onClick={() => setModalOpen(true)}
      >
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-primary/10 p-2">
                <Icon className="h-6 w-6 text-primary" />
              </div>
              <div>
                <CardTitle className="text-xl">{app.display_name}</CardTitle>
                <CardDescription className="mt-1">{app.tagline}</CardDescription>
              </div>
            </div>
            <Badge variant="secondary" className="text-xs">
              <Sparkles className="h-3 w-3 mr-1" />
              Offre site Veridian
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="py-4 text-center text-sm text-muted-foreground">
            <p>Cette app est <strong>incluse avec l&apos;achat d&apos;un site vitrine Veridian</strong>.</p>
            <p className="text-xs mt-2">Clique pour découvrir l&apos;offre.</p>
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
            <div className="rounded-md bg-primary/10 p-3 mb-1">
              <Icon className="h-8 w-8 text-primary" />
            </div>
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
