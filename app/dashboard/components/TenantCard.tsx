'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useEnv } from '@/contexts/EnvContext';
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
import { Loader2, ExternalLink, Info, Mail } from 'lucide-react';
import { StartTrialButton } from './StartTrialButton';

interface TenantCardProps {
  service: 'notifuse';
  configured: boolean;
  available?: boolean;
  slug?: string;
  userEmail?: string;
  tenantId?: string;
}

export function TenantCard({
  service: _service,
  configured,
  available = true,
  slug,
  userEmail: _userEmail,
  tenantId,
}: TenantCardProps) {
  const env = useEnv();
  const [loading, setLoading] = useState(false);

  const serviceName = 'Notifuse';
  const serviceDescription = 'Emails transactionnels et notifications';

  const handleOpenService = async () => {
    setLoading(true);

    try {
      if (!tenantId) {
        const fallback = (env.NEXT_PUBLIC_NOTIFUSE_URL || 'https://notifuse.app.veridian.site') + '/console';
        window.open(fallback, '_blank');
        toast.info('Connexion manuelle', {
          description: "Workspace pas encore complètement provisionné — ouverture de la console.",
        });
        return;
      }

      const res = await fetch('/api/admin/notifuse/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      const data = await res.json();

      const targetUrl = data.autoLoginUrl || data.magicLink;
      if (!res.ok || !targetUrl) {
        const fallback = (env.NEXT_PUBLIC_NOTIFUSE_URL || 'https://notifuse.app.veridian.site') + '/console';
        window.open(fallback, '_blank');
        toast.error('Connexion automatique indisponible', {
          description: data.error || 'Ouverture de la console sans connexion automatique.',
          duration: 5000,
        });
        return;
      }

      window.open(targetUrl, '_blank');
    } catch (error: any) {
      console.error('Error opening service:', error);
      toast.error("Erreur à l'ouverture du service", {
        description: error.message,
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Mail className="h-6 w-6 text-primary" />
            </div>
            <div>
              <CardTitle className="text-xl">{serviceName}</CardTitle>
              <CardDescription className="mt-1">
                {serviceDescription}
              </CardDescription>
            </div>
          </div>
          {configured && (
            <Badge variant="success">Actif</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {configured ? (
          <div className="space-y-2">
            {slug && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Workspace :</span>
                <code className="bg-muted px-2 py-1 rounded text-xs">
                  {slug}
                </code>
              </div>
            )}

            <Alert variant="info" className="mt-4">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs space-y-2">
                <div>
                  <strong>Workspace : {slug}</strong>
                </div>
                <div>
                  Clique sur &ldquo;Ouvrir&rdquo; pour te connecter automatiquement avec un nouveau magic link
                </div>
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">
              Envoie tes emails transactionnels
            </p>
            <p className="text-xs">
              Essai gratuit 15 jours — aucune carte bancaire demandée.
            </p>
          </div>
        )}
      </CardContent>

      <CardFooter>
        {configured ? (
          <div className="w-full space-y-2">
            <Button
              onClick={handleOpenService}
              disabled={loading}
              className="w-full"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Ouverture...
                </>
              ) : (
                <>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Ouvrir {serviceName}
                </>
              )}
            </Button>
          </div>
        ) : !available ? (
          <Button disabled className="w-full" variant="outline" size="lg">
            Indisponible dans cet environnement
          </Button>
        ) : (
          <StartTrialButton app="notifuse" openAfter="auto_login_url" />
        )}
      </CardFooter>
    </Card>
  );
}
