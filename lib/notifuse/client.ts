/**
 * Client Notifuse Veridian-aware.
 *
 * Couvre les endpoints HMAC-signés exposés par le fork Notifuse pour piloter le
 * cycle de vie des tenants depuis le Hub (provision, plan, suspend, resume,
 * delete, status) ainsi que l'endpoint authentifié par API key tenant
 * (generateMagicLink) pour fabriquer un lien d'auto-login depuis la console
 * client.
 *
 * Voir docs/saas-standards.md §6.1 pour le format HMAC partagé.
 */

import { createHmac } from 'crypto';

import {
  MagicLinkInput,
  MagicLinkResponse,
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
      workspace_name: input.workspaceName,
      plan: input.plan,
    });
  }

  async updatePlan(input: UpdatePlanInput): Promise<void> {
    await this.hmacRequest<unknown>('POST', '/api/tenants/update-plan', {
      tenant_id: input.tenantId,
      plan: input.plan,
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

  async getStatus(tenantId: string): Promise<StatusResponse> {
    return this.hmacRequest<StatusResponse>(
      'GET',
      `/api/tenants/${encodeURIComponent(tenantId)}/status`,
      null,
    );
  }

  async generateMagicLink(input: MagicLinkInput): Promise<MagicLinkResponse> {
    return this.apiKeyRequest<MagicLinkResponse>(
      'POST',
      '/api/workspaces.generateMagicLink',
      { user_email: input.userEmail },
      input.apiKey,
    );
  }

  // --- internals ---

  private signRequest(body: string): { timestamp: string; signature: string } {
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', this.hubSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return { timestamp, signature };
  }

  private async hmacRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<T> {
    const rawBody = body == null ? '' : JSON.stringify(body);
    const { timestamp, signature } = this.signRequest(rawBody);
    const headers: Record<string, string> = {
      'X-Veridian-Timestamp': timestamp,
      'X-Veridian-Hub-Signature': signature,
    };
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
    }
    return this.executeWithRetry<T>(method, path, headers, rawBody);
  }

  private async apiKeyRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    apiKey: string,
  ): Promise<T> {
    const rawBody = body == null ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    if (rawBody) {
      headers['Content-Type'] = 'application/json';
    }
    return this.executeWithRetry<T>(method, path, headers, rawBody);
  }

  private async executeWithRetry<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
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
          headers,
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
