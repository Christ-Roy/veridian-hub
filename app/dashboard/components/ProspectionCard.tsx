'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ExternalLink, Info } from 'lucide-react';
import { AppIdentity } from './AppIdentity';
import { StartTrialButton } from './StartTrialButton';

interface ProspectionCardProps {
  configured: boolean;
  /** Ouverture par le rebond signé du Hub (VER-106) ; `null` : app non branchée ici. */
  url: string | null;
  plan?: string;
}

export function ProspectionCard({ configured, url, plan = 'freemium' }: ProspectionCardProps) {
  // Pas de quota chiffré dans le label — docs/PRICING-VERIDIAN.md interdit
  // les compteurs visibles (tout illimité, conversion par la durée Free).
  const planLabel = plan === 'freemium' ? 'Free' : plan === 'pro' ? 'Pro' : plan;

  return (
    <Card className="flex flex-col h-full hover:shadow-lg transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <AppIdentity app="prospection" />
            <div>
              <CardTitle className="text-xl">Veridian Prospection</CardTitle>
              <CardDescription className="mt-1">
                Base de données B2B
              </CardDescription>
            </div>
          </div>
          {configured && (
            <Badge variant="success" className="shrink-0">
              Actif
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1">
        {configured ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Formule :</span>
              <code className="bg-muted px-2 py-1 rounded text-xs">
                {planLabel}
              </code>
            </div>

            <Alert variant="info" className="mt-4">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                <span>
                  <strong>Connexion automatique activée</strong> — cliquez pour ouvrir votre tableau de bord
                </span>
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">
              Récupérez les coordonnées d&apos;entreprises dans votre cible
            </p>
          </div>
        )}
      </CardContent>

      <CardFooter>
        {configured ? (
          url && (
            <Button asChild className="w-full" size="lg">
              <a href={url} target="_blank" rel="noopener">
                <ExternalLink className="mr-2 h-4 w-4" />
                Ouvrir Prospection
              </a>
            </Button>
          )
        ) : (
          <StartTrialButton app="prospection" openAfter={url} />
        )}
      </CardFooter>
    </Card>
  );
}
