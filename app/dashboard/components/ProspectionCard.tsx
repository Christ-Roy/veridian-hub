'use client';

import { useState } from 'react';
import { toast } from 'sonner';
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
import { Loader2, ExternalLink, Info } from 'lucide-react';
import { AppIdentity } from './AppIdentity';
import { StartTrialButton } from './StartTrialButton';

interface ProspectionCardProps {
  configured: boolean;
  loginUrl?: string | null;
  tokenValid: boolean;
  plan?: string;
}

export function ProspectionCard({
  configured,
  loginUrl,
  tokenValid,
  plan = 'freemium',
}: ProspectionCardProps) {
  const [loading, setLoading] = useState(false);

  // Pas de quota chiffré dans le label — docs/PRICING-VERIDIAN.md interdit
  // les compteurs visibles (tout illimité, conversion par la durée Free).
  const planLabel = plan === 'freemium' ? 'Free' : plan === 'pro' ? 'Pro' : plan;

  const handleOpen = async () => {
    setLoading(true);
    try {
      // On régénère TOUJOURS un token, même si `tokenValid` est true.
      //
      // POURQUOI (ticket `todo/2026-07-06-autologin-cross-app-casse.md`) : le
      // token de login Prospection est à USAGE UNIQUE côté app, mais le Hub ne
      // teste que son ÂGE (< 23h, cf. `app/dashboard/page.tsx`). La colonne
      // `prospection_login_token_used` existe mais n'est jamais mise à jour —
      // Prospection n'émet aucun webhook `token.used`. Le raccourci
      // « token encore jeune → réutilise l'URL » rouvrait donc un token déjà
      // consommé, et le client atterrissait sur `/login?error=token_used`
      // (constaté en prod sur la démo Céline).
      //
      // Coût : un appel API (~200 ms) par clic. Négligeable face à un client
      // qui se fait rejeter sur l'écran de login de son propre outil.
      const res = await fetch('/api/prospection/regenerate-login', {
        method: 'POST',
      });
      const data = await res.json();

      if (!res.ok || !data.login_url) {
        // Dernier recours : si le token en base est encore jeune, il a une
        // chance de n'avoir jamais été consommé. Mieux que ne rien ouvrir.
        if (tokenValid && loginUrl) {
          window.open(loginUrl, '_blank');
          return;
        }
        toast.error('Impossible de générer le lien de connexion', {
          description: data.error || 'Erreur inconnue',
          duration: 5000,
        });
        return;
      }

      window.open(data.login_url, '_blank');
    } catch (error: any) {
      console.error('Error opening Prospection:', error);
      toast.error('Erreur', {
        description: error.message || "Impossible d'ouvrir Prospection",
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="flex flex-col h-full hover:shadow-lg transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between">
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
            <Badge variant="success">
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
                {/* Message unique : depuis le fix du token usage-unique, chaque
                    clic régénère un lien frais — il n'y a plus deux états à
                    distinguer pour le client. */}
                <span>
                  <strong>Connexion automatique activée</strong> — clique pour ouvrir ton tableau de bord
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
          <Button
            onClick={handleOpen}
            disabled={loading}
            className="w-full"
            size="lg"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {tokenValid ? 'Ouverture...' : 'Génération du lien...'}
              </>
            ) : (
              <>
                <ExternalLink className="mr-2 h-4 w-4" />
                Ouvrir Prospection
              </>
            )}
          </Button>
        ) : (
          <StartTrialButton app="prospection" openAfter="login_url" />
        )}
      </CardFooter>
    </Card>
  );
}
