"use client";

import { useState, useTransition } from 'react';
import { Database, ExternalLink, Loader2, Zap } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

export type CrmCardVariant =
  | { kind: 'inactive' }
  | { kind: 'loading' }
  | {
      kind: 'active';
      status: 'active' | 'suspended' | 'error';
    };

export function CrmStatusCard({ variant }: { variant: CrmCardVariant }) {
  if (variant.kind === 'inactive') {
    return <ActivateCrmCard />;
  }
  if (variant.kind === 'loading') {
    return <LoadingCrmCard />;
  }
  return <ActiveCrmCard status={variant.status} />;
}

function ActivateCrmCard() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleActivate() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/dashboard/crm/activate', {
          method: 'POST',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Activation impossible');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <CardTitle>Active ton CRM Veridian</CardTitle>
        </div>
        <CardDescription>
          Provisionne ton workspace CRM dédié en quelques secondes —
          pipelines par défaut, accès via magic-link, sync auto depuis
          Prospection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <Zap className="mt-0.5 h-4 w-4 flex-none text-primary" />
            <span>Pipeline leads + opportunités prêt à l'emploi</span>
          </li>
          <li className="flex items-start gap-2">
            <Zap className="mt-0.5 h-4 w-4 flex-none text-primary" />
            <span>Sync auto depuis Prospection (leads → CRM)</span>
          </li>
          <li className="flex items-start gap-2">
            <Zap className="mt-0.5 h-4 w-4 flex-none text-primary" />
            <span>Accès via magic-link, pas de mot de passe à retenir</span>
          </li>
        </ul>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button onClick={handleActivate} disabled={isPending}>
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Activation en cours…
            </>
          ) : (
            <>Activer mon CRM</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function LoadingCrmCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <CardTitle>CRM en cours de provisionnement</CardTitle>
          <Badge variant="secondary">Provisionnement…</Badge>
        </div>
        <CardDescription>
          Ton workspace CRM est en cours de création. Cette opération prend
          généralement moins d'une minute — recharge la page dans quelques
          instants.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button disabled>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Provisionnement…
        </Button>
      </CardContent>
    </Card>
  );
}

function ActiveCrmCard({
  status,
}: {
  status: 'active' | 'suspended' | 'error';
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleOpenCrm() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          '/api/dashboard/crm/regenerate-magic-link',
          { method: 'POST' },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const { magicLinkUrl } = (await res.json()) as {
          magicLinkUrl: string;
        };
        window.open(magicLinkUrl, '_blank', 'noopener,noreferrer');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ouverture impossible');
      }
    });
  }

  const statusMeta = {
    active: { label: 'CRM actif', variant: 'default' as const },
    suspended: { label: 'Suspendu', variant: 'destructive' as const },
    error: { label: 'Erreur', variant: 'destructive' as const },
  }[status];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <CardTitle>Mon CRM Veridian</CardTitle>
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
        </div>
        <CardDescription>
          Ton workspace CRM est prêt. Ouvre-le via magic-link — pas besoin de
          mot de passe.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          onClick={handleOpenCrm}
          disabled={isPending || status !== 'active'}
        >
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Génération du lien…
            </>
          ) : (
            <>
              <ExternalLink className="mr-2 h-4 w-4" />
              Ouvrir mon CRM
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
