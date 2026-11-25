'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { redirectIfReauthRequired } from '@/lib/auth/reauth-redirect';
import { MESSAGE_RESEAU } from '@/lib/ui/messages';

type Liaison = { tenant_id: string; organisation: string; fournisseur: string; reliee: boolean };
const DIRE: Record<string, string> = {
  session_federee: 'Connectez-vous avec votre mot de passe ou Google pour changer vos connexions.',
  rate_limited: 'Trop de demandes. Réessayez dans une heure.',
  email_not_verified: 'Confirmez d\'abord votre adresse.',
  fournisseur_injoignable: 'Le service de connexion ne répond pas. Réessayez dans un instant.',
};

/** Les connexions d'organisation de la personne : elle relie la sienne, une fois, puis entre par elle. Rien à relier : rien à l'écran. */
export default function FederationForm() {
  const [liaisons, setLiaisons] = useState<Liaison[]>([]);
  const [occupe, setOccupe] = useState(false);
  const charger = () => fetch('/api/account/federation').then((r) => (r.ok ? r.json() : null)).then((j) => setLiaisons(j?.liaisons ?? [])).catch(() => undefined);
  useEffect(() => { void charger(); }, []);

  async function geste(l: Liaison) {
    toast.dismiss();
    setOccupe(true);
    try {
      const r = await fetch('/api/account/federation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geste: l.reliee ? 'delier' : 'relier', tenant_id: l.tenant_id }) });
      const j = await r.json().catch(() => ({}));
      if (redirectIfReauthRequired(j)) return;
      if (!r.ok) { toast.error(DIRE[j.error] ?? 'Connexion refusée.'); return; }
      if (j.url) { window.location.assign(j.url); return; }
      toast.success('Connexion déliée.');
      await charger();
    } catch {
      toast.error(MESSAGE_RESEAU);
    } finally {
      setOccupe(false);
    }
  }
  if (liaisons.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connexion par votre organisation</CardTitle>
        <CardDescription>
          Reliez une fois votre compte, puis connectez-vous avec lui. Quitter ce service ne ferme pas Veridian aussitôt : votre organisation vous retire ici, et c&apos;est immédiat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {liaisons.map((l) => (
          <div key={l.tenant_id} className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-medium">{l.fournisseur}</span> · {l.organisation}
              {l.reliee && <span className="text-muted-foreground"> · relié</span>}
            </p>
            <Button type="button" variant={l.reliee ? 'ghost' : 'default'} disabled={occupe} onClick={() => geste(l)}>
              {l.reliee ? `Délier ${l.fournisseur}` : `Relier mon compte ${l.fournisseur}`}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
