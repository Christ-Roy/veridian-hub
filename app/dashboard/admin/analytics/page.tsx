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
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">
          Analytics — Provisioning
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Gestion programmatique des tenants Veridian Analytics. Tout passe
          par une API server-to-server (<code>ANALYTICS_API_URL</code>).
        </p>
      </div>

      {fetchError && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
          <strong>Erreur de connexion Analytics :</strong> {fetchError}
          <p className="mt-2 text-xs">
            Vérifie <code>ANALYTICS_API_URL</code> et{' '}
            <code>ANALYTICS_ADMIN_KEY</code> dans l&apos;env du Hub.
          </p>
        </div>
      )}

      <section className="bg-white border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">Créer un tenant</h2>
        <form action={createTenantAction} className="grid gap-3 md:grid-cols-4">
          <input
            name="slug"
            placeholder="slug (ex: tramtech)"
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            className="border rounded px-3 py-2 text-sm"
          />
          <input
            name="name"
            placeholder="Nom affiche"
            required
            className="border rounded px-3 py-2 text-sm"
          />
          <input
            name="ownerEmail"
            type="email"
            placeholder="email owner (optionnel)"
            className="border rounded px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700"
          >
            Créer
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">
          Tenants ({tenants.length})
        </h2>
        {tenants.length === 0 && !fetchError && (
          <p className="text-sm text-gray-500">
            Aucun tenant pour le moment. Crée-en un ci-dessus.
          </p>
        )}
        <div className="space-y-4">
          {tenants.map((t) => (
            <div
              key={t.id}
              className="bg-white border rounded-lg p-4 space-y-3"
            >
              <div className="flex items-center gap-3">
                <div className="font-semibold text-gray-900">{t.name}</div>
                <code className="text-xs text-gray-500">{t.slug}</code>
                <span className="text-xs text-gray-400 font-mono">
                  {t.id}
                </span>
              </div>

              {t.sites && t.sites.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-gray-500">
                    Sites
                  </div>
                  {t.sites.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-3 text-sm py-1"
                    >
                      <code className="text-blue-600">{s.domain}</code>
                      <span className="text-gray-400 font-mono text-xs">
                        {s.siteKey}
                      </span>
                      {s.gscProperty && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">
                          GSC: {s.gscProperty.propertyUrl}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <details className="text-xs">
                <summary className="cursor-pointer text-indigo-600 hover:underline">
                  Ajouter un site
                </summary>
                <form
                  action={createSiteAction}
                  className="grid gap-2 md:grid-cols-4 mt-2"
                >
                  <input
                    type="hidden"
                    name="tenantId"
                    value={t.id}
                  />
                  <input
                    name="domain"
                    placeholder="tramtech.fr"
                    required
                    className="border rounded px-2 py-1"
                  />
                  <input
                    name="name"
                    placeholder="Site vitrine"
                    required
                    className="border rounded px-2 py-1"
                  />
                  <div></div>
                  <button
                    type="submit"
                    className="bg-gray-900 text-white rounded px-3 py-1"
                  >
                    Créer le site
                  </button>
                </form>
              </details>

              {t.sites && t.sites.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-indigo-600 hover:underline">
                    Attacher GSC à un site
                  </summary>
                  <form
                    action={attachGscAction}
                    className="grid gap-2 md:grid-cols-4 mt-2"
                  >
                    <select
                      name="siteId"
                      required
                      className="border rounded px-2 py-1"
                    >
                      {t.sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.domain}
                        </option>
                      ))}
                    </select>
                    <input
                      name="propertyUrl"
                      placeholder="sc-domain:tramtech.fr"
                      required
                      className="border rounded px-2 py-1 md:col-span-2"
                    />
                    <button
                      type="submit"
                      className="bg-gray-900 text-white rounded px-3 py-1"
                    >
                      Attacher
                    </button>
                  </form>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="bg-gray-50 border rounded-lg p-4 text-xs text-gray-600">
        <p className="font-semibold text-gray-900 mb-1">
          Comment utiliser le snippet tracker ?
        </p>
        <p>
          Une fois un site créé, récupère son <code>siteKey</code>, va dans{' '}
          <a
            href="https://analytics.app.veridian.site/dashboard"
            className="text-indigo-600 hover:underline"
          >
            Analytics → Dashboard
          </a>{' '}
          pour voir les data, et colle ce snippet sur le site client :
        </p>
        <pre className="bg-white border rounded p-2 mt-2 text-[11px] overflow-x-auto">
          {`<script async src="ANALYTICS_URL/tracker.js"
  data-site-key="SITE_KEY"
  data-veridian-track="auto"></script>`}
        </pre>
      </section>
    </div>
  );
}
