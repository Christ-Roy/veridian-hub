'use client';

// « Mon IA » (docs/MON-IA.md) : l'assistant DANS l'app. Une clé n'y est que le choix avancé, replié : le connecteur suffit pour que
// l'IA travaille dans toutes les apps (Robert, 25/11). La clé part au Hub et n'en revient jamais : seuls ses 4 derniers caractères s'affichent.
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Branchement = { fournisseur: string; modele: string; cleFin: string };
type Espace = { id: string; nom: string };
type Activation = { app: string; tenantId: string; enabled: boolean };

const FOURNISSEURS = [
  { cle: 'anthropic', nom: 'Anthropic' },
  { cle: 'openai', nom: 'OpenAI' },
  { cle: 'mistral', nom: 'Mistral' },
  { cle: 'openrouter', nom: 'OpenRouter' },
];
const APPS = [
  { cle: 'academy', nom: 'Academy' },
  { cle: 'crm', nom: 'CRM' },
];

export function MonIa(props: { branchements: Branchement[]; espaces: Espace[]; activations: Activation[]; apps: string[]; espacesParApp?: Record<string, string[]> }) {
  const [branchements, setBranchements] = useState(props.branchements);
  const [activations, setActivations] = useState(props.activations);
  const [fournisseur, setFournisseur] = useState('anthropic');
  const [modele, setModele] = useState('');
  const [cle, setCle] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function brancher(e: React.FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setMessage(null);
    const r = await fetch('/api/ia/branchement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fournisseur, modele: modele || undefined, cle }),
    });
    setCle(''); // la clé ne reste pas dans la page, même en cas d'échec
    setEnvoi(false);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setMessage(j.error === 'cle_invalide' ? 'Cette clé ne ressemble pas à une clé d\'API.' : 'Le branchement a échoué, réessayez.');
      return;
    }
    setBranchements((b) => [j.branchement, ...b.filter((x) => x.fournisseur !== j.branchement.fournisseur)]);
    setMessage('Votre IA est branchée.');
  }

  async function debrancher(f: string) {
    const r = await fetch(`/api/ia/branchement?fournisseur=${encodeURIComponent(f)}`, { method: 'DELETE' });
    if (r.ok) setBranchements((b) => b.filter((x) => x.fournisseur !== f));
  }

  async function basculer(app: string, tenantId: string, enabled: boolean) {
    const r = await fetch('/api/ia/activation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app, tenantId, enabled }),
    });
    if (r.ok) setActivations((a) => [...a.filter((x) => !(x.app === app && x.tenantId === tenantId)), { app, tenantId, enabled }]);
  }

  // Allumé d'office ; seule une ligne à `enabled = false` (retrait volontaire) l'éteint.
  const actif = (app: string, tenantId: string) => !activations.some((a) => a.app === app && a.tenantId === tenantId && !a.enabled);
  const apps = APPS.filter((a) => props.apps.includes(a.cle));

  return (
    <div className="space-y-6">
      {branchements.length > 0 && (
        <ul className="divide-y divide-border">
          {branchements.map((b) => (
            <li key={b.fournisseur} className="flex items-center justify-between gap-4 py-3 text-sm">
              <div>
                <p className="font-medium">{FOURNISSEURS.find((f) => f.cle === b.fournisseur)?.nom ?? b.fournisseur}</p>
                <p className="text-muted-foreground">
                  {b.modele} · clé terminant par {b.cleFin || '****'}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => debrancher(b.fournisseur)}>
                Débrancher
              </Button>
            </li>
          ))}
        </ul>
      )}

      {apps.length > 0 && props.espaces.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Assistant dans vos apps</h3>
          <p className="text-xs text-muted-foreground">Allumé d&apos;office, éteignable ici. Il agit dans l&apos;espace choisi, et vous demande avant toute modification.</p>
          <ul className="divide-y divide-border">
            {apps.flatMap((a) =>
              props.espaces.filter((e) => !props.espacesParApp || props.espacesParApp[a.cle]?.includes(e.id)).map((e) => (
                <li key={`${a.cle}-${e.id}`} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span>
                    {a.nom} · {e.nom}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant={actif(a.cle, e.id) ? 'default' : 'outline'}
                    onClick={() => basculer(a.cle, e.id, !actif(a.cle, e.id))}
                    aria-pressed={actif(a.cle, e.id)}
                  >
                    {actif(a.cle, e.id) ? 'Allumé' : 'Éteint'}
                  </Button>
                </li>
              )),
            )}
          </ul>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Utiliser une clé de fournisseur</summary>
        <form onSubmit={brancher} className="space-y-3 pt-3" autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ia-fournisseur">Fournisseur</Label>
              <select
                id="ia-fournisseur"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={fournisseur}
                onChange={(e) => setFournisseur(e.target.value)}
              >
                {FOURNISSEURS.map((f) => (
                  <option key={f.cle} value={f.cle}>
                    {f.nom}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ia-modele">Modèle (facultatif)</Label>
              <Input id="ia-modele" value={modele} onChange={(e) => setModele(e.target.value)} placeholder="par défaut" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ia-cle">Clé d&apos;API</Label>
            <Input id="ia-cle" type="password" value={cle} onChange={(e) => setCle(e.target.value)} required autoComplete="off" />
            <p className="text-xs text-muted-foreground">
              Chiffrée chez Veridian, jamais affichée. Vos questions sont facturées par votre fournisseur, sur votre compte.
            </p>
          </div>
          <Button type="submit" disabled={envoi || !cle}>
            {envoi ? 'Branchement…' : 'Brancher mon IA'}
          </Button>
          {message && <p className="text-sm">{message}</p>}
        </form>
      </details>
    </div>
  );
}
