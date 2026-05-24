'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Activity } from 'lucide-react';

/**
 * Card "Audit cross-app (dry-run)" sur la page overview admin.
 * Bouton qui POST /api/admin/reconcile-trigger (forcé dry-run côté serveur)
 * et affiche le résultat dans un panel collapsible inline (JSON brut +
 * compteurs en tête).
 *
 * Toast "Audit en cours…" pendant la requête (peut être long si beaucoup
 * de tenants — l'endpoint scan jusqu'à 100 par défaut).
 */
type ReconcileSummary = {
  usersScanned: number;
  appsQueried: number;
  appsUnreachable: number;
  driftsDetected: number;
  drifts: Array<{
    hubTenantId: string;
    app: string;
    kind: string;
    hubValue?: unknown;
    appValue?: unknown;
  }>;
  startedAt: string;
  durationMs: number;
  errors: Array<{ tenantId?: string; message: string }>;
};

export function ReconcileAuditCard() {
  const [isRunning, setIsRunning] = useState(false);
  const [summary, setSummary] = useState<ReconcileSummary | null>(null);
  const [open, setOpen] = useState(false);

  const handleRun = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setOpen(true);
    const loadingId = toast.loading('Audit cross-app en cours…', {
      description: 'Scan des tenants vs apps downstream (dry-run, aucune écriture).',
    });

    try {
      const res = await fetch('/api/admin/reconcile-trigger', { method: 'POST' });
      const data = await res.json();
      toast.dismiss(loadingId);

      if (!res.ok) {
        toast.error('Audit en erreur', {
          description: data.error ?? `HTTP ${res.status}`,
          duration: 6000,
        });
        return;
      }

      setSummary(data as ReconcileSummary);
      toast.success('Audit terminé', {
        description: `${data.driftsDetected} drifts sur ${data.usersScanned} tenants en ${Math.round(data.durationMs / 100) / 10}s.`,
        duration: 5000,
      });
    } catch (err) {
      toast.dismiss(loadingId);
      toast.error('Erreur réseau', {
        description: err instanceof Error ? err.message : 'Réessaie.',
        duration: 5000,
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-base">Audit cross-app</CardTitle>
              <CardDescription>
                Compare l&apos;état Hub vs apps downstream. Mode dry-run uniquement
                (aucune écriture, aucune persistance).
              </CardDescription>
            </div>
          </div>
          <Button onClick={handleRun} disabled={isRunning}>
            {isRunning ? 'Audit en cours…' : 'Auditer (dry-run uniquement)'}
          </Button>
        </div>
      </CardHeader>
      {open && summary && (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Tenants scannés" value={summary.usersScanned} />
            <Stat label="Apps interrogées" value={summary.appsQueried} />
            <Stat
              label="Apps injoignables"
              value={summary.appsUnreachable}
              warn={summary.appsUnreachable > 0}
            />
            <Stat
              label="Drifts détectés"
              value={summary.driftsDetected}
              warn={summary.driftsDetected > 0}
            />
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            Lancé à {new Date(summary.startedAt).toLocaleString('fr-FR')} —{' '}
            durée {Math.round(summary.durationMs / 100) / 10}s
          </div>
          <details className="rounded border bg-muted/30">
            <summary className="cursor-pointer px-3 py-2 text-xs font-mono">
              Voir le détail JSON
            </summary>
            <pre className="text-xs bg-card border-t p-3 overflow-x-auto max-h-96">
              {JSON.stringify(summary, null, 2)}
            </pre>
          </details>
        </CardContent>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={'text-2xl font-bold tabular-nums ' + (warn ? 'text-destructive' : '')}>
        {value}
      </div>
    </div>
  );
}
