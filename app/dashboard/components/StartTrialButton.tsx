'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2, Rocket } from 'lucide-react';
import { celebrate } from '@/lib/confetti';

interface StartTrialButtonProps {
  app: 'notifuse' | 'prospection';
  label?: string;
  /** Si fourni, on ouvre cette URL dans un nouvel onglet après succès. */
  openAfter?: 'auto_login_url' | 'login_url' | null;
}

export function StartTrialButton({
  app,
  label,
  openAfter = null,
}: StartTrialButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/tenants/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        toast.error("Échec du démarrage de l'essai", {
          description:
            data.errors?.join(', ') || data.error || 'Erreur inconnue',
          duration: 5000,
        });
        return;
      }

      // 🎉 Célébration : confettis aux couleurs Veridian
      celebrate();

      toast.success('Service activé', {
        description: 'On rafraîchit votre dashboard…',
      });

      if (openAfter) {
        const url =
          app === 'notifuse'
            ? data.notifuse?.auto_login_url
            : data.prospection?.login_url;
        if (url) {
          window.open(url, '_blank', 'noopener');
        }
      }

      // Délai laissé volontairement long pour que les confettis se déroulent
      // avant le rechargement du dashboard.
      setTimeout(() => window.location.reload(), 1600);
    } catch (e: any) {
      toast.error('Erreur réseau', {
        description: e?.message || 'Réessaye dans quelques secondes',
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      onClick={handleClick}
      disabled={loading}
      className="w-full cta-gradient-animated"
      size="lg"
    >
      {loading ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Démarrage...
        </>
      ) : (
        <>
          <Rocket className="mr-2 h-4 w-4" />
          {label ?? "Activer gratuitement"}
        </>
      )}
    </Button>
  );
}
