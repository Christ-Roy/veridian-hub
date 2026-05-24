/**
 * Hub Admin — Analytics tenants provisioning
 *
 * Liste les tenants de Veridian Analytics et permet de :
 * - Creer un tenant
 * - Ajouter un site au tenant (retourne le siteKey + snippet)
 * - Attacher une propriete GSC
 *
 * Toutes les actions passent par des server actions qui appellent
 * analyticsClient cote serveur (la cle admin n'est jamais exposee cote client).
 */
import { revalidatePath } from 'next/cache';
import {
  analyticsClient,
  AnalyticsApiError,
} from '@/lib/analytics/client';
import { BarChart3 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { AnalyticsTenantPanels } from './AnalyticsTenantPanels';

export const dynamic = 'force-dynamic';

async function createTenantAction(formData: FormData): Promise<void> {
  'use server';
  const slug = String(formData.get('slug') || '').trim();
  const name = String(formData.get('name') || '').trim();
  const ownerEmail = String(formData.get('ownerEmail') || '').trim();
  if (!slug || !name) {
    console.error('[admin/analytics] slug et nom requis');
    return;
  }
  try {
    await analyticsClient.createTenant({
      slug,
      name,
      ownerEmail: ownerEmail || undefined,
    });
  } catch (e) {
    const msg =
      e instanceof AnalyticsApiError
        ? `[${e.status}] ${e.message}`
        : e instanceof Error
          ? e.message
          : 'error';
    console.error('[admin/analytics] createTenant:', msg);
  }
  revalidatePath('/dashboard/admin/analytics');
}

async function createSiteAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = String(formData.get('tenantId') || '').trim();
  const domain = String(formData.get('domain') || '').trim();
  const name = String(formData.get('name') || '').trim();
  if (!tenantId || !domain || !name) {
    console.error('[admin/analytics] tenantId, domain et name requis');
    return;
  }
  try {
    await analyticsClient.createSite(tenantId, { domain, name });
  } catch (e) {
    const msg =
      e instanceof AnalyticsApiError
        ? `[${e.status}] ${e.message}`
        : e instanceof Error
          ? e.message
          : 'error';
    console.error('[admin/analytics] createSite:', msg);
  }
  revalidatePath('/dashboard/admin/analytics');
}

async function attachGscAction(formData: FormData): Promise<void> {
  'use server';
  const siteId = String(formData.get('siteId') || '').trim();
  const propertyUrl = String(formData.get('propertyUrl') || '').trim();
  if (!siteId || !propertyUrl) {
    console.error('[admin/analytics] siteId et propertyUrl requis');
    return;
  }
  try {
    await analyticsClient.attachGsc(siteId, propertyUrl);
  } catch (e) {
    const msg =
      e instanceof AnalyticsApiError
        ? `[${e.status}] ${e.message}`
        : e instanceof Error
          ? e.message
          : 'error';
    console.error('[admin/analytics] attachGsc:', msg);
  }
  revalidatePath('/dashboard/admin/analytics');
}

export default async function AdminAnalyticsPage() {
  let tenants: Awaited<
    ReturnType<typeof analyticsClient.listTenants>
  >['tenants'] = [];
  let fetchError: string | null = null;

  try {
    const data = await analyticsClient.listTenants();
    tenants = data.tenants;
  } catch (e) {
    fetchError =
      e instanceof Error ? e.message : 'Unable to reach Analytics API';
  }

  return (
    <div className="space-y-8">
      <DashboardPageHeader
        title="Analytics — Provisioning"
        icon={BarChart3}
        description={
          <>
            Gestion programmatique des tenants Veridian Analytics. Tout passe
            par une API server-to-server (<code>ANALYTICS_API_URL</code>).
          </>
        }
      />

      {fetchError && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-4 text-sm">
          <strong>Erreur de connexion Analytics :</strong> {fetchError}
          <p className="mt-2 text-xs">
            Vérifie <code>ANALYTICS_API_URL</code> et{' '}
            <code>ANALYTICS_ADMIN_KEY</code> dans l&apos;env du Hub.
          </p>
        </div>
      )}

      <Card>
        <CardContent className="p-6 space-y-4">
          <h2 className="text-lg font-semibold">Créer un tenant</h2>
          <form
            action={createTenantAction}
            className="grid gap-3 md:grid-cols-4"
          >
            <Input
              name="slug"
              placeholder="slug (ex: tramtech)"
              required
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            />
            <Input name="name" placeholder="Nom affiché" required />
            <Input
              name="ownerEmail"
              type="email"
              placeholder="email owner (optionnel)"
            />
            <Button type="submit">Créer</Button>
          </form>
        </CardContent>
      </Card>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">
          Tenants ({tenants.length})
        </h2>
        {tenants.length === 0 && !fetchError && (
          <p className="text-sm text-muted-foreground">
            Aucun tenant pour le moment. Crée-en un ci-dessus.
          </p>
        )}
        <div className="space-y-4">
          {tenants.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="font-semibold text-foreground">{t.name}</div>
                  <code className="text-xs text-muted-foreground">{t.slug}</code>
                  <span className="text-xs text-muted-foreground font-mono">
                    {t.id}
                  </span>
                </div>

                {t.sites && t.sites.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Sites
                    </div>
                    {t.sites.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-3 text-sm py-1"
                      >
                        <code className="text-primary">{s.domain}</code>
                        <span className="text-muted-foreground font-mono text-xs">
                          {s.siteKey}
                        </span>
                        {s.gscProperty && (
                          <Badge variant="success" className="rounded">
                            GSC: {s.gscProperty.propertyUrl}
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <AnalyticsTenantPanels
                  tenant={t}
                  createSiteAction={createSiteAction}
                  attachGscAction={attachGscAction}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-muted border border-border rounded-lg p-4 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">
          Comment utiliser le snippet tracker ?
        </p>
        <p>
          Une fois un site créé, récupère son <code>siteKey</code>, va dans{' '}
          <a
            href="https://analytics.app.veridian.site/dashboard"
            className="text-primary hover:underline"
          >
            Analytics → Dashboard
          </a>{' '}
          pour voir les data, et colle ce snippet sur le site client :
        </p>
        <pre className="bg-card border border-border rounded p-2 mt-2 text-xs overflow-x-auto">
          {`<script async src="ANALYTICS_URL/tracker.js"
  data-site-key="SITE_KEY"
  data-veridian-track="auto"></script>`}
        </pre>
      </section>
    </div>
  );
}
