'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { redirectIfReauthRequired } from '@/lib/auth/reauth-redirect';
import { MESSAGE_RESEAU } from '@/lib/ui/messages';

type Liste = { principale: string; secondaires: string[] };
const DIRE: Record<string, string> = {
  code_invalide: 'Code faux ou expiré. Redemandez-en un.',
  prise: 'Cette adresse ne peut pas être ajoutée.',
  rate_limited: 'Trop de demandes. Réessayez dans une heure.',
  email_not_verified: 'Confirmez d\'abord votre adresse principale.',
  not_found: 'Cette adresse n\'est plus rattachée.',
};

/** Les autres adresses d'une personne : elle prouve qu'elle les tient par un code, et les détache quand elle veut. */
export default function AdressesForm() {
  const [liste, setListe] = useState<Liste | null>(null);
  const [attente, setAttente] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const charger = () => fetch('/api/account/adresses').then((r) => (r.ok ? r.json() : null)).then(setListe).catch(() => undefined);
  useEffect(() => { void charger(); }, []);

  async function geste(corps: object, bien: string): Promise<boolean> {
    toast.dismiss();
    setOccupe(true);
    try {
      const r = await fetch('/api/account/adresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
      const j = await r.json().catch(() => ({}));
      if (redirectIfReauthRequired(j)) return false;
      if (!r.ok) { toast.error(DIRE[j.error] ?? 'Adresse refusée.'); return false; }
      toast.success(bien);
      await charger();
      return true;
    } catch {
      toast.error(MESSAGE_RESEAU);
      return false;
    } finally {
      setOccupe(false);
    }
  }
  async function demander(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('adresse') ?? '').trim().toLowerCase();
    if (email && (await geste({ geste: 'demander', email }, 'Si cette adresse peut être ajoutée, un code y est parti.'))) setAttente(email);
  }
  async function confirmer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    if (attente && (await geste({ geste: 'confirmer', email: attente, code }, 'Adresse ajoutée.'))) setAttente(null);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vos autres adresses</CardTitle>
        <CardDescription>Une organisation peut vous reconnaître par l&apos;une d&apos;elles. Vous vous connectez toujours avec votre adresse principale.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {liste?.secondaires.length ? (
          <ul className="flex flex-col gap-2">
            {liste.secondaires.map((e) => (
              <li key={e} className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm">{e}</span>
                <Button type="button" variant="outline" size="sm" disabled={occupe} onClick={() => geste({ geste: 'detacher', email: e }, 'Adresse détachée.')} aria-label={`Détacher ${e}`}>Détacher</Button>
              </li>
            ))}
          </ul>
        ) : null}
        {attente ? (
          <form onSubmit={confirmer} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="code-adresse">Code reçu à {attente}</Label>
              <Input id="code-adresse" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
            </div>
            <Button type="submit" disabled={occupe}>Confirmer</Button>
            <Button type="button" variant="ghost" onClick={() => setAttente(null)}>Annuler</Button>
          </form>
        ) : (
          <form onSubmit={demander} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="autre-adresse">Ajouter une adresse</Label>
              <Input id="autre-adresse" name="adresse" type="email" autoComplete="email" maxLength={254} required />
            </div>
            <Button type="submit" variant="outline" disabled={occupe}>Recevoir un code</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
