/**
 * Analytics admin API client — typed wrapper around Veridian Analytics
 * admin endpoints, consumed by the Hub for tenant provisioning.
 *
 * Env vars required on the Hub runtime :
 *   ANALYTICS_API_URL        e.g. https://analytics.app.veridian.site
 *   ANALYTICS_ADMIN_KEY      admin API key (server-side only, NEVER exposed to client)
 *
 * Usage :
 *   import { analyticsClient } from '@/lib/analytics/client';
 *   const { tenant } = await analyticsClient.createTenant({
 *     slug: 'tramtech', name: 'Tramtech', ownerEmail: 'contact@tramtech.fr'
 *   });
 */

export type AnalyticsTenant = {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sites?: AnalyticsSite[];
  memberships?: Array<{
    role: string;
    user: { id: string; email: string };
  }>;
};

export type AnalyticsSite = {
  id: string;
  tenantId: string;
  domain: string;
  name: string;
  siteKey: string;
  createdAt: string;
  gscProperty?: { propertyUrl: string; lastSyncAt: string | null } | null;
};

export type AnalyticsIntegration = {
  siteKey: string;
  trackerScript: string;
  endpoints: {
    pageview: string;
    form: string;
    call: string;
    gsc: string;
  };
};

export class AnalyticsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

function baseUrl(): string {
  const url = process.env.ANALYTICS_API_URL;
  if (!url) throw new Error('ANALYTICS_API_URL not set');
  return url.replace(/\/$/, '');
}

function adminKey(): string {
  const key = process.env.ANALYTICS_ADMIN_KEY;
  if (!key) throw new Error('ANALYTICS_ADMIN_KEY not set');
  return key;
}

async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey(),
        ...(rest.headers || {}),
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await res.text();
    const body = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      const errMsg =
        (body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : null) || `HTTP ${res.status}`;
      throw new AnalyticsApiError(errMsg, res.status, body);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const analyticsClient = {
  // ---- Tenants ----
  async listTenants(): Promise<{ tenants: AnalyticsTenant[] }> {
    return request('/api/admin/tenants');
  },

  async getTenant(tenantId: string): Promise<{ tenant: AnalyticsTenant }> {
    return request(`/api/admin/tenants/${tenantId}`);
  },

  async createTenant(input: {
    slug: string;
    name: string;
    ownerEmail?: string;
  }): Promise<{ tenant: AnalyticsTenant }> {
    return request('/api/admin/tenants', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateTenant(
    tenantId: string,
    patch: { name?: string },
  ): Promise<{ tenant: AnalyticsTenant }> {
    return request(`/api/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async deleteTenant(
    tenantId: string,
    opts: { hard?: boolean } = {},
  ): Promise<{ ok: true; hard: boolean }> {
    const qs = opts.hard ? '?hard=true' : '';
    return request(`/api/admin/tenants/${tenantId}${qs}`, {
      method: 'DELETE',
    });
  },

  // ---- Sites ----
  async listSites(tenantId: string): Promise<{ sites: AnalyticsSite[] }> {
    return request(`/api/admin/tenants/${tenantId}/sites`);
  },

  async createSite(
    tenantId: string,
    input: { domain: string; name: string },
  ): Promise<{ site: AnalyticsSite; integration: AnalyticsIntegration }> {
    return request(`/api/admin/tenants/${tenantId}/sites`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async deleteSite(
    siteId: string,
    opts: { hard?: boolean } = {},
  ): Promise<{ ok: true; hard: boolean }> {
    const qs = opts.hard ? '?hard=true' : '';
    return request(`/api/admin/sites/${siteId}${qs}`, { method: 'DELETE' });
  },

  async rotateSiteKey(
    siteId: string,
  ): Promise<{ site: { id: string; domain: string; siteKey: string } }> {
    return request(`/api/admin/sites/${siteId}?action=rotate-key`, {
      method: 'POST',
    });
  },

  // ---- GSC ----
  async attachGsc(
    siteId: string,
    propertyUrl: string,
  ): Promise<{ gscProperty: unknown }> {
    return request(`/api/admin/sites/${siteId}/gsc`, {
      method: 'PUT',
      body: JSON.stringify({ propertyUrl }),
    });
  },

  async detachGsc(siteId: string): Promise<{ ok: true }> {
    return request(`/api/admin/sites/${siteId}/gsc`, { method: 'DELETE' });
  },

  async syncGsc(opts: { siteId?: string; days?: number } = {}): Promise<{
    ok: boolean;
    range?: { start: string; end: string };
    results?: Array<{
      siteId: string;
      propertyUrl: string;
      upserted: number;
      errors: string[];
    }>;
  }> {
    return request('/api/admin/gsc/sync', {
      method: 'POST',
      body: JSON.stringify(opts),
      timeoutMs: 240_000, // GSC can be slow
    });
  },
};
