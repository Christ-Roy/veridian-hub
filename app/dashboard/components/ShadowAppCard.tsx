'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ExternalLink, Lock } from 'lucide-react';
import type { AppMetadata } from '@/lib/pricing/plans';

interface ShadowAppCardProps {
  app: AppMetadata;
}

/**
 * Card "shadow marketing" pour apps client_only (Analytics, CMS) quand le
 * tenant n'a pas de plan lifetime_site_vitrine. Cf CONTRAT-HUB.md §8.9.
 *
 * État visuel : card grisée + badge "Inclus avec un site Veridian". Au click,
 * modal explicative + CTA vers veridian.site/sites.
 */
export function ShadowAppCard({ app }: ShadowAppCardProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <Card
        className="opacity-60 cursor-pointer hover:opacity-80 hover:shadow-md transition-all border-dashed"
        onClick={() => setModalOpen(true)}
      >
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                <span className="text-2xl">{app.icon}</span>
                <span>{app.display_name}</span>
              </CardTitle>
              <CardDescription className="mt-1">{app.tagline}</CardDescription>
            </div>
            <Badge variant="warning" className="text-xs">
              <Lock className="h-3 w-3 mr-1" />
              Site Veridian
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="py-4 text-center text-sm text-muted-foreground">
            <p>Cette app est <strong>incluse avec l&apos;achat d&apos;un site vitrine Veridian</strong>.</p>
            <p className="text-xs mt-2">Click pour en savoir plus.</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="outline" className="w-full" size="lg" onClick={(e) => { e.stopPropagation(); setModalOpen(true); }}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Découvrir les sites Veridian
          </Button>
        </CardFooter>
      </Card>

      {modalOpen && (
        <ShadowAppModal app={app} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}

function ShadowAppModal({ app, onClose }: { app: AppMetadata; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg mx-4 animate-in slide-in-from-bottom-4 duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <Card className="p-8 shadow-2xl">
          <div className="text-center mb-6">
            <div className="text-5xl mb-3">{app.icon}</div>
            <h2 className="text-2xl font-bold">{app.display_name}</h2>
            <p className="text-sm text-muted-foreground mt-2">{app.tagline}</p>
          </div>

          <Alert variant="warning" className="mb-6">
            <AlertDescription>
              Cette application est <strong>incluse avec l&apos;achat d&apos;un site vitrine Veridian</strong>.
              Découvre nos offres clé en main pour entrepreneurs et TPE.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-2">
            <Button
              className="w-full"
              size="lg"
              onClick={() => {
                if (app.marketing_url) {
                  window.open(app.marketing_url, '_blank', 'noopener,noreferrer');
                }
                onClose();
              }}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Voir les sites Veridian
            </Button>
            <Button variant="outline" className="w-full" onClick={onClose}>
              Fermer
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
