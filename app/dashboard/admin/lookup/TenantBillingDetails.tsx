'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Collapsible inline qui fetch `/api/admin/tenant-billing-state` à la
 * demande et affiche le JSON formaté. Évite de cascader les fetch au
 * load (lookup peut retourner N tenants).
 *
 * Pas d'effet sur l'historique (juste un toggle local).
 */
type BillingStatePayload = {
  ok: true;
  response: {
    tenant_id: string;
    plan: string;
    plan_source: string;
    stripe_subscription_id: string | null;
    effective_at: string;
    updated_at: string;
  };
  cached: boolean;
};

export function TenantBillingDetails({
  tenantId,
  app,
}: {
  tenantId: string;
  app: 'notifuse' | 'prospection';
}) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [payload, setPayload] = useState<BillingStatePayload | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleToggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);

    // Lazy load au premier open
    if (payload || isLoading) return;

    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/admin/tenant-billing-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, app }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
        return;
      }
      setPayload(data as BillingStatePayload);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erreur réseau');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded border bg-muted/30">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggle}
        className="w-full justify-between font-mono text-xs h-9 px-3"
        aria-expanded={open}
      >
        <span>
          billing-state — <strong>{app}</strong>
        </span>
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
      </Button>
      {open && (
        <div className="px-3 pb-3 pt-1">
          {isLoading && <p className="text-xs text-muted-foreground">Chargement…</p>}
          {errorMsg && (
            <p className="text-xs text-destructive" role="alert">
              {errorMsg}
            </p>
          )}
          {payload && (
            <pre className="text-xs bg-card border rounded p-2 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
