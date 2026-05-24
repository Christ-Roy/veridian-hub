'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TenantBillingDetails } from './TenantBillingDetails';

/**
 * Form admin lookup : input email + bouton "Rechercher" → POST
 * `/api/admin/users-lookup`. Affiche user + N cards tenant (collapsible
 * via `<details>` natif pour zéro JS supplémentaire).
 *
 * Pattern bouton aligné sur le reste du dashboard : disabled durant
 * submit + label dynamique. Pas de gestion d'historique URL (lookup
 * admin = action, pas un share link).
 */
type AdminUserResult = {
  user: {
    id: string;
    email: string;
    name: string | null;
    email_verified: string | null;
    mfa_enabled: boolean;
    supabase_user_id: string | null;
    created_at: string;
    providers: Array<{ provider: string; provider_account_id: string; type: string }>;
    active_sessions: number;
  };
  tenants: Array<{
    id: string;
    name: string | null;
    slug: string | null;
    status: string | null;
    notifuseWorkspaceSlug: string | null;
    notifusePlan: string | null;
    prospectionPlan: string | null;
    prospectionProvisionedAt: string | null;
    metadata: Record<string, unknown> | null;
    provisionedAt: string | null;
    createdAt: string;
  }>;
};

export function UserLookupForm() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<AdminUserResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = email.trim().toLowerCase();
    if (!cleaned || isSubmitting) return;

    setIsSubmitting(true);
    setResult(null);
    setNotFound(false);

    try {
      const res = await fetch('/api/admin/users-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleaned }),
      });

      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error('Erreur lookup', {
          description: data.error ?? `HTTP ${res.status}`,
          duration: 5000,
        });
        return;
      }

      const data: AdminUserResult = await res.json();
      setResult(data);
    } catch (err) {
      toast.error('Erreur réseau', {
        description: err instanceof Error ? err.message : 'Réessaie.',
        duration: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <div className="flex-1 space-y-2">
          <Label htmlFor="admin-lookup-email">Email du user</Label>
          <Input
            id="admin-lookup-email"
            type="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isSubmitting}
            required
            autoFocus
          />
        </div>
        <Button type="submit" disabled={isSubmitting || !email.trim()}>
          {isSubmitting ? 'Recherche…' : 'Rechercher'}
        </Button>
      </form>

      {notFound && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Aucun user trouvé pour <span className="font-mono">{email}</span>.
          </CardContent>
        </Card>
      )}

      {result && <UserResultCard result={result} />}
    </div>
  );
}

function UserResultCard({ result }: { result: AdminUserResult }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{result.user.name ?? 'Sans nom'}</CardTitle>
          <CardDescription className="font-mono">{result.user.email}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Field label="User ID" value={result.user.id} mono />
            <Field
              label="Bridge UUID"
              value={result.user.supabase_user_id ?? 'absent'}
              mono
            />
            <Field
              label="Email vérifié"
              value={result.user.email_verified ? 'oui' : 'non'}
            />
            <Field
              label="MFA"
              value={result.user.mfa_enabled ? 'activé' : 'désactivé'}
            />
            <Field label="Sessions actives" value={String(result.user.active_sessions)} />
            <Field
              label="Créé le"
              value={new Date(result.user.created_at).toLocaleString('fr-FR')}
            />
          </div>

          {result.user.providers.length > 0 && (
            <div className="pt-2">
              <div className="text-xs uppercase text-muted-foreground tracking-wide mb-2">
                Providers OAuth
              </div>
              <div className="flex flex-wrap gap-2">
                {result.user.providers.map((p, i) => (
                  <Badge key={`${p.provider}-${i}`} variant="secondary">
                    {p.provider}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Tenants ({result.tenants.length})
        </h3>
        {result.tenants.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              Aucun tenant pour ce user.
            </CardContent>
          </Card>
        ) : (
          result.tenants.map((t) => <TenantCard key={t.id} tenant={t} />)
        )}
      </div>
    </div>
  );
}

function TenantCard({ tenant }: { tenant: AdminUserResult['tenants'][number] }) {
  const apps: Array<'notifuse' | 'prospection'> = [];
  if (tenant.notifuseWorkspaceSlug) apps.push('notifuse');
  if (tenant.prospectionProvisionedAt) apps.push('prospection');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">{tenant.name ?? tenant.slug ?? 'Tenant'}</CardTitle>
            <CardDescription className="font-mono text-xs">{tenant.id}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {tenant.status && <Badge variant="outline">{tenant.status}</Badge>}
            {apps.map((a) => (
              <Badge key={a}>{a}</Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Field label="Slug" value={tenant.slug ?? '—'} mono />
          <Field label="Plan Notifuse" value={tenant.notifusePlan ?? '—'} />
          <Field label="Plan Prospection" value={tenant.prospectionPlan ?? '—'} />
          <Field
            label="Provisionné"
            value={
              tenant.provisionedAt
                ? new Date(tenant.provisionedAt).toLocaleDateString('fr-FR')
                : '—'
            }
          />
        </div>

        {apps.length > 0 && (
          <div className="space-y-2 pt-2">
            {apps.map((app) => (
              <TenantBillingDetails key={app} tenantId={tenant.id} app={app} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={mono ? 'font-mono text-xs truncate' : 'text-sm truncate'} title={value}>
        {value}
      </div>
    </div>
  );
}
