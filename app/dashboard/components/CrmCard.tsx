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
import { Loader2, ExternalLink } from 'lucide-react';
import { AppIdentity } from './AppIdentity';

interface CrmCardProps {
  /** True si l'user a déjà un CrmTenant active en DB. Affiche "Ouvrir" sinon "Démarrer". */
  configured: boolean;
  /**
   * True si l'app `twenty` est activée pour ce tenant (flag TenantApp, piloté
   * par l'admin SaaS). DÉFAUT false : le CRM n'est pas grand public, la card
   * reste en mode "Bientôt" (bouton désactivé) tant que Robert ne l'a pas
   * activée pour ce tenant via l'Admin API.
   */
  enabled?: boolean;
}

/**
 * Card CRM Veridian — pattern aligné Notifuse / Prospection.
 *
 * Au clic :
 * - POST /api/dashboard/crm/activate (lazy provision + auto-login)
 * - Réponse contient `magicLinkUrl` → window.open _blank pour login Twenty
 *
 * Pas de page custom /dashboard/crm — tout passe par cette card +
 * fenêtre Twenty ouverte.
 */
export function CrmCard({ configured, enabled = false }: CrmCardProps) {
  const [loading, setLoading] = useState(false);

  const handleActivateOrOpen = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dashboard/crm/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();

      if (!res.ok || !data.magicLinkUrl) {
        toast.error('Impossible d\'ouvrir le CRM', {
          description: data.message || data.error || 'Réessaye dans quelques secondes.',
          duration: 5000,
        });
        return;
      }

      window.open(data.magicLinkUrl, '_blank');

      if (!data.idempotent) {
        toast.success('CRM Veridian activé', {
          description: 'Ton workspace CRM a été créé et est ouvert dans un nouvel onglet.',
        });
      }
    } catch (err) {
      console.error('CrmCard activate error:', err);
      toast.error('Erreur réseau', {
        description: err instanceof Error ? err.message : 'Une erreur est survenue.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <AppIdentity app="crm" />
            <CardTitle>Veridian CRM</CardTitle>
          </div>
          {!enabled ? (
            <Badge variant="outline">Bientôt</Badge>
          ) : (
            configured && <Badge variant="secondary">Actif</Badge>
          )}
        </div>
        <CardDescription>
          Le premier CRM IA-first, entièrement pilotable par l&apos;intelligence
          artificielle.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>• Piloté par l&apos;IA, de bout en bout</li>
          <li>• Vos contacts et entreprises réunis</li>
          <li>• Suivi de vos opportunités commerciales</li>
        </ul>
      </CardContent>

      <CardFooter>
        {!enabled ? (
          // App gated non activée pour ce tenant : pas grand public encore.
          // Bouton inerte "Bientôt disponible" (l'activation se fait côté admin).
          <Button disabled className="w-full" variant="outline">
            Bientôt disponible
          </Button>
        ) : (
          <Button
            onClick={handleActivateOrOpen}
            disabled={loading}
            className="w-full"
            variant={configured ? 'default' : 'outline'}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                {configured ? 'Ouverture…' : 'Création du workspace…'}
              </>
            ) : (
              <>
                <ExternalLink className="mr-2 size-4" />
                {configured ? 'Ouvrir mon CRM' : 'Activer mon CRM'}
              </>
            )}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
