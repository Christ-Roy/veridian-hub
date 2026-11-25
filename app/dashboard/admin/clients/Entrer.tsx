'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Entree, EtatApp, Org } from '@/lib/emprunt/entrees';

const ETATS: Record<EtatApp, string> = {
  ouverte: 'Ouverte',
  suspendue: 'Suspendue',
  compte_sans_espace: 'Sans espace',
  inconnu: 'Pas de compte',
  non_activee: 'Non activée',
  illisible: 'Sans réponse',
  non_branchee: 'Non branchée',
};

export function Entrer({ hubUserId, apps, organisations }: { hubUserId: string; apps: Entree[]; organisations: Org[] }) {
  const ouvrables = organisations.filter((o) => !o.suspendue);
  const [tenantId, setTenantId] = useState(ouvrables[0]?.id ?? '');
  const [raison, setRaison] = useState('');
  const [enCours, setEnCours] = useState<string | null>(null);

  async function entrer(a: Entree) {
    if (enCours) return;
    setEnCours(a.app);
    try {
      const res = await fetch('/api/admin/emprunt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubUserId, app: a.app, tenantId: tenantId || null, raison: raison || null }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; message?: string; login_url?: string };
      if (res.ok && j.url) return void window.location.assign(j.url);
      if (j.login_url) return void window.location.assign(`${j.login_url}&callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      toast.error(`${a.libelle} ne s'est pas ouverte`, { description: j.message ?? `Réponse ${res.status}` });
    } catch {
      toast.error(`${a.libelle} ne s'est pas ouverte`, { description: 'Le Hub n\'a pas répondu.' });
    }
    setEnCours(null);
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="raison-emprunt">Raison (facultative, gardée au journal)</Label>
          <Input id="raison-emprunt" value={raison} onChange={(e) => setRaison(e.target.value)} maxLength={300} autoComplete="off" />
        </div>
        {ouvrables.length > 1 && (
          <div className="space-y-2">
            <Label htmlFor="organisation-emprunt">Arriver dans</Label>
            <select id="organisation-emprunt" value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              {ouvrables.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nom}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {apps.map((a) => (
          <li key={a.app} data-app={a.app} data-etat={a.etat} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.libelle}</span>
                <Badge variant={a.entrable ? 'default' : a.etat === 'illisible' || a.etat === 'suspendue' ? 'destructive' : 'secondary'}>{ETATS[a.etat]}</Badge>
              </div>
              {a.espaces.length > 0 && (
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  {a.espaces.map((e) => `${e.nom}${e.organisation ? '' : ' (non relié à une organisation)'}`).join(', ')}
                </p>
              )}
              {a.detail && <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>}
            </div>
            <Button type="button" variant={a.entrable ? 'default' : 'outline'} disabled={!a.entrable || enCours !== null} onClick={() => entrer(a)}>
              {enCours === a.app ? 'Ouverture…' : 'Entrer'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
