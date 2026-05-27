"use client";

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Database, ExternalLink, Loader2, Sparkles, Zap } from 'lucide-react';
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
  | { kind: 'gated' }
  | { kind: 'inactive'; planLabel: string }
  | {
      kind: 'active';
      planLabel: string;
      status: 'provisioning' | 'active' | 'suspended' | 'error';
    };

export function CrmStatusCard({ variant }: { variant: CrmCardVariant }) {
  if (variant.kind === 'gated') {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-muted-foreground" />
            <CardTitle>CRM Veridian</CardTitle>
            <Badge variant="secondary">Pro+</Badge>
          </div>
          <CardDescription>
            Le CRM Veridian est inclus à partir du plan Pro. Centralise tes
            leads, automatise tes relances et garde le contexte sur chaque
            contact.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/pricing">
              <Sparkles className="mr-2 h-4 w-4" />
              Voir les offres
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (variant.kind === 'inactive') {
    return <ActivateCrmCard planLabel={variant.planLabel} />;
  }

  return (
    <ActiveCrmCard planLabel={variant.planLabel} status={variant.status} />
  );
}

function ActivateCrmCard({ planLabel }: { planLabel: string }) {
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
        // Recharge la page pour afficher la card "active"
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
          <Badge>{planLabel}</Badge>
        </div>
        <CardDescription>
          Ton plan inclut un CRM dédié — il sera provisionné en quelques
          secondes avec ton workspace, tes pipelines par défaut et l'accès
          via magic-link.
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

function ActiveCrmCard({
  planLabel,
  status,
}: {
  planLabel: string;
  status: 'provisioning' | 'active' | 'suspended' | 'error';
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
    provisioning: {
      label: 'Provisionnement…',
      variant: 'secondary' as const,
    },
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
          <Badge variant="outline" className="ml-auto">
            {planLabel}
          </Badge>
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
