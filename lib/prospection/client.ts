/**
 * Client Prospection Veridian-aware.
 *
 * Implémente le format HMAC standard contrat §6.1 :
 *   - Headers `X-Veridian-Timestamp` (unix ms) + `X-Veridian-Hub-Signature` (hex)
 *   - Signature : `hmac_sha256(secret, "${timestamp}.${raw_body}")`
 *   - Anti-replay 5min côté Prospection + `timingSafeEqual`
 *
 * Miroir de `lib/notifuse/client.ts` — pattern identique, types adaptés au
 * domaine Prospection (provision + lifecycle).
 *
 * ENV requis :
 *   - PROSPECTION_API_URL
 *   - PROSPECTION_HUB_API_SECRET (cible contrat §6.5) ou
 *     PROSPECTION_TENANT_API_SECRET (legacy, fallback)
 */

import { createHmac } from 'crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = (status: number) => status >= 500 && status < 600;

export class ProspectionError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ProspectionError';
  }
}

export interface ProvisionInput {
  email: string;
  name: string;
  userId: string;
  plan?: string;
}

export interface ProvisionResponse {
  tenant_id: string;
  api_key: string;
  login_url: string;
  created?: boolean;
}

export interface ProspectionClientOptions {
  apiUrl: string;
  hubSecret: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class ProspectionClient {
  private readonly apiUrl: string;
  private readonly hubSecret: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ProspectionClientOptions) {
    if (!opts.apiUrl) {
      throw new Error('ProspectionClient: apiUrl is required');
    }
    if (!opts.hubSecret) {
      throw new Error('ProspectionClient: hubSecret is required');
    }
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.hubSecret = opts.hubSecret;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async provisionTenant(input: ProvisionInput): Promise<ProvisionResponse> {
    return this.hmacRequest<ProvisionResponse>('POST', '/api/tenants/provision', {
      email: input.email,
      name: input.name,
      plan: input.plan ?? 'freemium',
      user_id: input.userId,
      metadata: { hub_user_id: input.userId },
    });
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
          typeof errorBody === 'object' && errorBody && 'error' in errorBody
            ? String((errorBody as { error: unknown }).error)
            : `Prospection ${method} ${path} failed (${response.status})`;

        if (RETRYABLE_STATUS(response.status) && attempt < this.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw new ProspectionError(errorMessage, response.status, errorBody);
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof ProspectionError) throw err;

        lastError = err;
        if (attempt < this.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProspectionError(
            `Prospection ${method} ${path} timed out after ${this.timeoutMs}ms`,
            0,
            null,
          );
        }
        throw err;
      }
    }

    throw lastError ?? new Error('ProspectionClient: unknown error');
  }
}

/**
 * Helper: lit le secret avec fallback legacy.
 * Cible contrat : PROSPECTION_HUB_API_SECRET.
 * Legacy (30j) : PROSPECTION_TENANT_API_SECRET.
 */
export function readProspectionSecret(): string | null {
  return (
    process.env.PROSPECTION_HUB_API_SECRET ||
    process.env.PROSPECTION_TENANT_API_SECRET ||
    null
  );
}

let _secretPrefixLogged = false;

/**
 * Log l'empreinte (8 premiers chars) du secret au premier appel, une seule
 * fois par process. Permet de comparer avec Prospection en cas de désync
 * (cf contrat §6.5).
 */
function logSecretPrefixOnce(secret: string): void {
  if (_secretPrefixLogged || process.env.NODE_ENV === 'test') return;
  _secretPrefixLogged = true;
  const source = process.env.PROSPECTION_HUB_API_SECRET
    ? 'PROSPECTION_HUB_API_SECRET'
    : 'PROSPECTION_TENANT_API_SECRET (legacy)';
  console.log(
    `[hub] Prospection secret prefix: ${secret.slice(0, 8)}... (source: ${source})`,
  );
}

/**
 * Helper: instancie un ProspectionClient depuis l'ENV, ou null si non
 * configuré (URL ou secret absent).
 */
export function createProspectionClientFromEnv(): ProspectionClient | null {
  const apiUrl = process.env.PROSPECTION_API_URL;
  const hubSecret = readProspectionSecret();
  if (!apiUrl || !hubSecret) return null;
  logSecretPrefixOnce(hubSecret);
  return new ProspectionClient({ apiUrl, hubSecret });
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
