'use client';

// Brancher son abonnement Claude (moteur `claude-code-abonnement`, docs/MON-IA.md). Le client se connecte lui-même
// chez Anthropic, dans son navigateur ; il recolle ici le code qu'Anthropic lui affiche, tapé tel quel dans le
// programme officiel. Veridian ne voit ni son mot de passe ni son jeton.
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Statut = { connecte: boolean; email?: string | null; abonnement?: string | null };

/**
 * La vraie raison d'un échec, jamais un « réessayez » générique (23/11 : l'atelier en panne, Robert recliquait dans le
 * vide). Le code reste affiché pour le support.
 */
export function messageEchec(code: string | undefined, etape: 'debut' | 'code'): string {
  switch (code) {
    case 'atelier_injoignable':
    case 'atelier_indisponible':
    case 'hors_reseau_atelier':
    case 'binaire_introuvable':
      return "Le service qui relie votre abonnement est indisponible : l'incident est de notre côté. Inutile de recliquer, réessayez plus tard.";
    case 'abonnement_ferme':
    case 'client_refuse':
      return "Le branchement par abonnement n'est pas ouvert pour ce compte.";
    case 'adresse_introuvable':
      return "Anthropic n'a pas proposé de page de connexion. Réessayez dans quelques minutes.";
    case 'connexion_non_commencee':
      return 'La connexion a expiré (10 minutes). Recommencez depuis « Brancher mon abonnement ».';
    case 'code_invalide':
      return "Ce code n'a pas la forme attendue : copiez-le en entier depuis la page d'Anthropic.";
    case 'connexion_refusee':
      return "Anthropic a refusé ce code (déjà utilisé ou expiré). Recommencez la connexion.";
    default:
      return etape === 'debut' ? "La connexion n'a pas pu démarrer." : "Le code n'a pas été accepté. Recommencez la connexion.";
  }
}

async function appel(action: string, extra: Record<string, unknown> = {}) {
  const r = await fetch('/api/ia/abonnement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  return { ok: r.ok, j: (await r.json().catch(() => ({}))) as Statut & { url?: string; error?: string } };
}

export function MonAbonnement({ branche }: { branche: boolean }) {
  const [statut, setStatut] = useState<Statut | null>(branche ? { connecte: true } : null);
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function commencer() {
    setEnvoi(true);
    setMessage(null);
    const { ok, j } = await appel('debut');
    setEnvoi(false);
    if (!ok || !j.url) return setMessage(`${messageEchec(j.error, 'debut')}${j.error ? ` (code : ${j.error})` : ''}`);
    setUrl(j.url);
  }

  async function valider(e: React.FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    const { ok, j } = await appel('code', { code });
    setCode('');
    setEnvoi(false);
    if (!ok || !j.connecte) return setMessage(`${messageEchec(j.error, 'code')}${j.error ? ` (code : ${j.error})` : ''}`);
    setUrl(null);
    setStatut(j);
    setMessage('Votre abonnement est branché.');
  }

  async function debrancher() {
    const { ok } = await appel('fin');
    if (ok) setStatut(null);
  }

  if (statut?.connecte) {
    return (
      <div className="flex items-center justify-between gap-4 text-sm">
        <p>
          Abonnement branché{statut.email ? ` (${statut.email})` : ''}
          {statut.abonnement ? `, ${statut.abonnement}` : ''}.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={debrancher}>
          Débrancher
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Utilisez votre abonnement Claude (Pro, Max…) au lieu d&apos;une clé : l&apos;Assistant Veridian exécute Claude Code pour vous,
        sur votre compte. Vous vous connectez vous-même chez Anthropic.
      </p>
      {!url ? (
        <Button type="button" onClick={commencer} disabled={envoi}>
          {envoi ? 'Préparation…' : 'Brancher mon abonnement'}
        </Button>
      ) : (
        <form onSubmit={valider} className="space-y-2" autoComplete="off">
          <p>
            1.{' '}
            <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
              Ouvrez la page de connexion d&apos;Anthropic
            </a>{' '}
            et connectez-vous.
          </p>
          <p>2. Collez ici le code qu&apos;Anthropic vous affiche :</p>
          <div className="flex gap-2">
            <Input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code de connexion" autoComplete="off" />
            <Button type="submit" disabled={envoi || code.trim().length < 8}>
              Valider
            </Button>
          </div>
        </form>
      )}
      {message && <p>{message}</p>}
    </div>
  );
}
