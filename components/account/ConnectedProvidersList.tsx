'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Provider = {
  id: string;
  provider: string;
  providerAccountId: string;
  type: string;
};

const PROVIDER_LABELS: Record<string, { name: string; icon: string }> = {
  google: { name: 'Google', icon: '🔵' },
  'microsoft-entra-id': { name: 'Microsoft', icon: '🔴' },
  credentials: { name: 'Email + Mot de passe', icon: '🔐' },
};

const OAUTH_PROVIDERS = ['google', 'microsoft-entra-id'] as const;

export default function ConnectedProvidersList() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const res = await fetch('/api/account/connected-providers', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setProviders(data.providers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors du chargement des providers.');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleConnect = (provider: 'google' | 'microsoft-entra-id') => {
    // Auth.js redirige le navigateur vers le provider, qui revient sur le
    // callback OAuth standard. Le user existant sera lié au compte courant
    // grâce à allowDangerousEmailAccountLinking si l'email matche.
    signIn(provider, { callbackUrl: '/dashboard/settings' });
  };

  const handleDisconnect = async (provider: string) => {
    setDisconnecting(provider);
    setError(null);
    try {
      const res = await fetch(`/api/account/connected-providers/${provider}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? `Erreur HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de déconnecter ce provider.');
    } finally {
      setDisconnecting(null);
    }
  };

  if (providers === null && !error) {
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  }

  const connected = new Set(providers?.map((p) => p.provider) ?? []);
  const oauthAvailable = OAUTH_PROVIDERS.filter((p) => !connected.has(p));

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Providers connectés */}
      {providers && providers.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {providers.map((p) => {
            const meta = PROVIDER_LABELS[p.provider] ?? { name: p.provider, icon: '🔗' };
            const isOauth = OAUTH_PROVIDERS.includes(p.provider as (typeof OAUTH_PROVIDERS)[number]);
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 p-3"
                data-provider={p.provider}
              >
                <span className="text-xl" aria-hidden>{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{meta.name}</p>
                  <p className="text-sm text-muted-foreground truncate">
                    {p.providerAccountId}
                  </p>
                </div>
                {isOauth && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleDisconnect(p.provider)}
                    disabled={disconnecting === p.provider}
                  >
                    {disconnecting === p.provider ? 'Déconnexion…' : 'Déconnecter'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !error && (
          <p className="text-sm text-muted-foreground">
            Aucun provider connecté.
          </p>
        )
      )}

      {/* Boutons pour connecter un nouveau provider */}
      {oauthAvailable.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Ajouter une méthode de connexion :
          </p>
          <div className="flex flex-wrap gap-2">
            {oauthAvailable.map((p) => {
              const meta = PROVIDER_LABELS[p];
              return (
                <Button
                  key={p}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleConnect(p)}
                  data-connect-provider={p}
                >
                  <span aria-hidden className="mr-2">{meta.icon}</span>
                  Connecter {meta.name}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
