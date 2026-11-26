/**
 * Client Notifuse Veridian-aware.
 *
 * Couvre les endpoints HMAC-signés exposés par le fork Notifuse pour piloter le
 * cycle de vie des tenants depuis le Hub (provision, plan, suspend, resume,
 * delete, status). L'ouverture de Mail passe par le rebond signé (lib/auth/bounce-apps.ts).
 *
 * Voir docs/saas-standards.md §6.1 pour le format HMAC partagé.
 */

import { entetesSignature } from '@/lib/hmac/signature-hub';

import {
  AttachOwnerInput,
  AttachOwnerResponse,
  HealthResponse,
  NotifuseError,
  ProvisionInput,
  ProvisionResponse,
  ResumeInput,
  StatusResponse,
  SuspendInput,
  UpdatePlanInput,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = (status: number) => status >= 500 && status < 600;

export interface NotifuseClientOptions {
  apiUrl: string;
  hubSecret: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class NotifuseClient {
  private readonly apiUrl: string;
  private readonly hubSecret: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NotifuseClientOptions) {
    if (!opts.apiUrl) {
      throw new Error('NotifuseClient: apiUrl is required');
    }
    if (!opts.hubSecret) {
      throw new Error('NotifuseClient: hubSecret is required');
    }
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.hubSecret = opts.hubSecret;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async provisionWorkspace(input: ProvisionInput): Promise<ProvisionResponse> {
    return this.hmacRequest<ProvisionResponse>('POST', '/api/tenants/provision', {
      tenant_id: input.tenantId,
      owner_email: input.ownerEmail,
      ...(input.hubUserId ? { owner_hub_user_id: input.hubUserId } : {}),
      workspace_name: input.workspaceName,
      plan: input.plan,
      ...(input.hubUserId || input.hubTenantId
        ? { metadata: { ...(input.hubUserId ? { hub_user_id: input.hubUserId } : {}), ...(input.hubTenantId ? { hub_tenant_id: input.hubTenantId } : {}) } }
        : {}),
      ...(input.hubTenantId ? { hub_tenant_id: input.hubTenantId } : {}),
      ...(input.emailProven ? { email_proven: true } : {}),
    });
  }

  /**
   * Relie l'espace Mail à son organisation du Hub, SANS toucher au plan (POST /api/hub/tenants/link). Mail résout le tenant d'un jeton
   * d'action par ce lien seul : sans lui, ses actions rendent 409 espace_non_relie. 409 hub_tenant_conflict : déjà relié ailleurs, rien écrit.
   * `absente` : la route n'est pas encore servie par Mail (404 sans code), le lien reste celui de l'update-plan à la création.
   */
  async lierTenantHub(tenantId: string, hubTenantId: string): Promise<{ ok: true; changed: boolean } | { ok: false; absente?: true; code: number; erreur: string }> {
    try {
      const r = await this.hmacRequest<{ changed?: boolean }>('POST', '/api/hub/tenants/link', { tenant_id: tenantId, hub_tenant_id: hubTenantId });
      return { ok: true, changed: r?.changed === true };
    } catch (err) {
      if (!(err instanceof NotifuseError)) return { ok: false, code: 0, erreur: err instanceof Error ? err.message.slice(0, 160) : 'erreur' };
      const code = (err.body as { error?: string } | null)?.error;
      if (err.code === 404 && !code) return { ok: false, absente: true, code: 404, erreur: 'route_absente' };
      return { ok: false, code: err.code, erreur: code ?? err.message.slice(0, 160) };
    }
  }

  async updatePlan(input: UpdatePlanInput): Promise<void> {
    await this.hmacRequest<unknown>('POST', '/api/tenants/update-plan', {
      tenant_id: input.tenantId,
      plan: input.plan,
      ...(input.trial ? { trial_status: input.trial.status, trial_ends_at: input.trial.endsAt } : {}),
      ...(input.hubTenantId ? { hub_tenant_id: input.hubTenantId } : {}),
    });
  }

  async suspendWorkspace(input: SuspendInput): Promise<void> {
    await this.hmacRequest<unknown>('POST', '/api/tenants/suspend', {
      tenant_id: input.tenantId,
      reason: input.reason,
    });
  }

  async resumeWorkspace(input: ResumeInput): Promise<void> {
    await this.hmacRequest<unknown>('POST', '/api/tenants/resume', {
      tenant_id: input.tenantId,
    });
  }

  async deleteWorkspace(tenantId: string): Promise<void> {
    await this.hmacRequest<unknown>(
      'DELETE',
      `/api/tenants/${encodeURIComponent(tenantId)}`,
      null,
    );
  }

  /** Workspaces dont l'identifiant commence par ce préfixe, orphelins compris (restes de test). */
  async listTenantsByPrefix(prefix: string): Promise<string[]> {
    const q = new URLSearchParams({ prefix, include_orphans: 'true', limit: '500' });
    const res = await this.hmacRequest<{
      managed?: { tenant_id: string }[];
      orphans?: { tenant_id: string }[];
    }>('GET', `/api/veridian/admin/tenants?${q}`, null);
    return [...(res.managed ?? []), ...(res.orphans ?? [])].map((t) => t.tenant_id);
  }

  async getStatus(tenantId: string): Promise<StatusResponse> {
    return this.hmacRequest<StatusResponse>(
      'GET',
      `/api/tenants/${encodeURIComponent(tenantId)}/status`,
      null,
    );
  }

  /**
   * Répare un workspace existant en y attachant un user humain comme owner.
   *
   * Idempotent : si l'user est déjà owner du workspace, renvoie
   * `already_attached: true` sans modif. Un AUTRE propriétaire humain : 409
   * `owner_exists`, rien n'est écrit. Mail sait le transférer (`transfer: true`,
   * qui rétrograde l'ancien) : le Hub ne l'envoie jamais.
   *
   * Use case principal : réparer les tenants prod où `Provision` historique
   * n'avait pas attaché l'owner humain au workspace (bug 2026-05-17, 11 tenants
   * concernés).
   *
   * Endpoint : POST /api/veridian/admin/attach-owner (HMAC Hub).
   */
  async attachOwner(input: AttachOwnerInput): Promise<AttachOwnerResponse> {
    const body: Record<string, unknown> = {
      tenant_id: input.tenantId,
      owner_email: input.ownerEmail,
      hub_user_id: input.hubUserId,
    };
    if (!input.hubUserId) throw new Error('NotifuseClient.attachOwner: hubUserId est requis (VER-255)');
    if (input.role) {
      body.role = input.role;
    }
    return this.hmacRequest<AttachOwnerResponse>(
      'POST',
      '/api/veridian/admin/attach-owner',
      body,
    );
  }

  /**
   * Renvoie l'état observable du tenant côté Notifuse.
   *
   * Le champ critique est `magic_link_capable` : si `false`, le flow auto-login
   * Hub → Notifuse va casser (redirect /console/workspace/create). Côté Hub,
   * brancher en cron pour détecter les désync en pré-mortem.
   *
   * Endpoint : GET /api/tenants/{tenantId}/health (HMAC Hub).
   */
  async getHealth(tenantId: string): Promise<HealthResponse> {
    if (!tenantId) {
      throw new Error('NotifuseClient.getHealth: tenantId is required');
    }
    return this.hmacRequest<HealthResponse>(
      'GET',
      `/api/tenants/${encodeURIComponent(tenantId)}/health`,
      null,
    );
  }

  // --- internals ---

  /**
   * Les en-têtes d'UNE tentative : signature neuve (timestamp neuf) à chaque envoi et à chaque nouvel essai,
   * la v2 étant à usage unique côté serveur (`lib/hmac/signature-hub.ts`).
   */
  private entetes(method: string, url: string, rawBody: string): Record<string, string> {
    const headers: Record<string, string> = entetesSignature({
      secret: this.hubSecret,
      methode: method,
      url,
      corps: rawBody,
      app: 'notifuse',
    });
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async hmacRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<T> {
    const rawBody = body == null ? '' : JSON.stringify(body);
    return this.executeWithRetry<T>(method, path, rawBody);
  }

  private async executeWithRetry<T>(
    method: string,
    path: string,
    rawBody: string,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: this.entetes(method, url, rawBody),
          body: rawBody && method !== 'GET' ? rawBody : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          if (response.status === 204) {
            return undefined as T;
          }
          const text = await response.text();
          if (!text) return undefined as T;
          return JSON.parse(text) as T;
        }

        const errorBody = await safeReadJson(response);
        const errorMessage =
          (typeof errorBody === 'object' && errorBody && 'error' in errorBody
            ? String((errorBody as { error: unknown }).error)
            : `Notifuse ${method} ${path} failed (${response.status})`);

        if (RETRYABLE_STATUS(response.status) && attempt < this.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }

        throw new NotifuseError(errorMessage, response.status, errorBody);
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof NotifuseError) throw err;

        lastError = err;
        if (attempt < this.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          throw new NotifuseError(
            `Notifuse ${method} ${path} timed out after ${this.timeoutMs}ms`,
            0,
            null,
          );
        }
        throw err;
      }
    }

    throw lastError ?? new Error('NotifuseClient: unknown error');
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 5000);
}
