/**
 * Client CRM (Twenty fork) — orchestre les 6 GraphQL calls de provisioning
 * + la régénération de magic link + le push de leads via REST.
 *
 * Spec : `todo/2026-05-27-route-admin-create-crm-tenant.md` — flow validé
 * sur staging 2026-05-27 (Twenty v2.8 sur crm.staging.veridian.site).
 *
 * Garde-fous :
 *  - Aucun secret loggué (ni password, ni Bearer)
 *  - Timeout configurable (défaut 30s par étape)
 *  - Retry léger UNIQUEMENT sur erreurs réseau / 5xx (pas sur erreurs GraphQL)
 *  - Échec dur si une étape ne retourne pas le champ attendu
 *  - Ne stocke RIEN — c'est la responsabilité du caller (route admin)
 *
 * Pattern : API consumption pure (Bearer accessToken pour les étapes 3-6),
 * pas de HMAC bidirectionnel comme Notifuse. Le CRM Twenty ne connaît pas
 * le Hub.
 */

import { randomBytes } from 'node:crypto';

import {
  CreateCrmTenantInput,
  CreateCrmTenantResult,
  CrmClientError,
  PushLeadInput,
  PushLeadResult,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1; // 1 retry = 2 tentatives totales
const API_KEY_LIFESPAN_MS = 365 * 24 * 60 * 60 * 1000; // 1 an

export interface CrmClientOptions {
  metadataUrl: string;
  restUrl: string;
  frontendUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /**
   * Générateur d'expiry. Injectable pour tests (figer la date). Par défaut :
   * `Date.now() + 1 an` arrondi à la seconde.
   */
  apiKeyExpiresAt?: () => Date;
  /**
   * Générateur de password. Injectable pour tests. Par défaut : 32 bytes
   * cryptographiquement aléatoires encodés base64url.
   */
  generatePassword?: () => string;
}

export class CrmClient {
  private readonly metadataUrl: string;
  private readonly restUrl: string;
  private readonly frontendUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKeyExpiresAt: () => Date;
  private readonly generatePassword: () => string;

  constructor(opts: CrmClientOptions) {
    if (!opts.metadataUrl) throw new Error('CrmClient: metadataUrl is required');
    if (!opts.restUrl) throw new Error('CrmClient: restUrl is required');
    if (!opts.frontendUrl) throw new Error('CrmClient: frontendUrl is required');
    this.metadataUrl = opts.metadataUrl.replace(/\/+$/, '');
    this.restUrl = opts.restUrl.replace(/\/+$/, '');
    this.frontendUrl = opts.frontendUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiKeyExpiresAt =
      opts.apiKeyExpiresAt ??
      (() => new Date(Math.floor((Date.now() + API_KEY_LIFESPAN_MS) / 1000) * 1000));
    this.generatePassword =
      opts.generatePassword ?? (() => randomBytes(24).toString('base64url'));
  }

  /**
   * Provisionne un tenant Twenty complet : user + workspace activé + API
   * key Bearer (1 an). Enchaîne les 6 GraphQL calls — voir le ticket pour
   * le détail des mutations / queries.
   */
  async createTenant(input: CreateCrmTenantInput): Promise<CreateCrmTenantResult> {
    const email = input.email.trim().toLowerCase();
    const workspaceName = input.workspaceName.trim();
    if (!email) throw new CrmClientError('email is required', { step: 'validate' });
    if (!workspaceName)
      throw new CrmClientError('workspaceName is required', { step: 'validate' });

    const password = this.generatePassword();

    // ─── Étape 1 : signUpInWorkspace ──────────────────────────────────────
    const signUpResp = await this.graphql<{
      signUpInWorkspace: {
        loginToken: { token: string; expiresAt: string };
        workspace: { id: string; workspaceUrls: { subdomainUrl: string } };
      };
    }>({
      step: 'signUpInWorkspace',
      query: `
        mutation SignUp($email: String!, $password: String!) {
          signUpInWorkspace(email: $email, password: $password) {
            loginToken { token expiresAt }
            workspace { id workspaceUrls { subdomainUrl } }
          }
        }
      `,
      variables: { email, password },
    });

    const loginToken = signUpResp.signUpInWorkspace?.loginToken?.token;
    const workspaceId = signUpResp.signUpInWorkspace?.workspace?.id;
    const workspaceUrl = signUpResp.signUpInWorkspace?.workspace?.workspaceUrls?.subdomainUrl;
    if (!loginToken || !workspaceId || !workspaceUrl) {
      throw new CrmClientError('signUpInWorkspace: missing loginToken/workspace fields', {
        step: 'signUpInWorkspace',
        body: signUpResp,
      });
    }

    // ─── Étape 2 : getAuthTokensFromLoginToken ─────────────────────────────
    const tokensResp = await this.graphql<{
      getAuthTokensFromLoginToken: {
        tokens: {
          accessOrWorkspaceAgnosticToken: { token: string };
          refreshToken: { token: string };
        };
      };
    }>({
      step: 'getAuthTokensFromLoginToken',
      query: `
        mutation GetTokens($loginToken: String!, $origin: String!) {
          getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
            tokens {
              accessOrWorkspaceAgnosticToken { token }
              refreshToken { token }
            }
          }
        }
      `,
      variables: { loginToken, origin: workspaceUrl },
    });

    const accessToken =
      tokensResp.getAuthTokensFromLoginToken?.tokens?.accessOrWorkspaceAgnosticToken?.token;
    if (!accessToken) {
      throw new CrmClientError('getAuthTokensFromLoginToken: missing accessToken', {
        step: 'getAuthTokensFromLoginToken',
        body: tokensResp,
      });
    }

    // ─── Étape 3 : activateWorkspace ──────────────────────────────────────
    await this.graphql<{
      activateWorkspace: { id: string; displayName: string; activationStatus: string };
    }>({
      step: 'activateWorkspace',
      bearer: accessToken,
      query: `
        mutation ActivateWorkspace($input: ActivateWorkspaceInput!) {
          activateWorkspace(data: $input) {
            id displayName activationStatus
          }
        }
      `,
      variables: { input: { displayName: workspaceName } },
    });

    // ─── Étape 4 : getRoles (filter Admin) ────────────────────────────────
    const rolesResp = await this.graphql<{
      getRoles: Array<{ id: string; label: string }>;
    }>({
      step: 'getRoles',
      bearer: accessToken,
      query: `query GetRoles { getRoles { id label } }`,
    });

    const adminRole = rolesResp.getRoles?.find((r) => r.label === 'Admin');
    if (!adminRole) {
      throw new CrmClientError(
        'getRoles: Admin role not found — workspace probably not activated',
        { step: 'getRoles', body: rolesResp },
      );
    }

    // ─── Étape 5 : createApiKey ───────────────────────────────────────────
    const expiresAt = this.apiKeyExpiresAt();
    const expiresAtIso = expiresAt.toISOString();

    const createKeyResp = await this.graphql<{
      createApiKey: { id: string; name: string; expiresAt: string };
    }>({
      step: 'createApiKey',
      bearer: accessToken,
      query: `
        mutation CreateApiKey($input: CreateApiKeyInput!) {
          createApiKey(input: $input) { id name expiresAt }
        }
      `,
      variables: {
        input: {
          name: 'Veridian Hub Admin Key',
          expiresAt: expiresAtIso,
          roleId: adminRole.id,
        },
      },
    });

    const apiKeyId = createKeyResp.createApiKey?.id;
    if (!apiKeyId) {
      throw new CrmClientError('createApiKey: missing id', {
        step: 'createApiKey',
        body: createKeyResp,
      });
    }

    // ─── Étape 6 : generateApiKeyToken (Bearer réel) ──────────────────────
    const tokenResp = await this.graphql<{
      generateApiKeyToken: { token: string };
    }>({
      step: 'generateApiKeyToken',
      bearer: accessToken,
      query: `
        mutation GenerateApiKeyToken($apiKeyId: UUID!, $expiresAt: String!) {
          generateApiKeyToken(apiKeyId: $apiKeyId, expiresAt: $expiresAt) {
            token
          }
        }
      `,
      variables: { apiKeyId, expiresAt: expiresAtIso },
    });

    const apiKeyToken = tokenResp.generateApiKeyToken?.token;
    if (!apiKeyToken) {
      throw new CrmClientError('generateApiKeyToken: missing token', {
        step: 'generateApiKeyToken',
        body: tokenResp,
      });
    }

    // Le loginToken de l'étape 1 est encore valide 15 min — on l'expose
    // directement comme magic link initial sans re-call étape 7.
    const initialMagicLinkUrl = this.buildMagicLink(workspaceUrl, loginToken);

    return {
      twentyWorkspaceId: workspaceId,
      twentyWorkspaceUrl: workspaceUrl,
      twentyApiKeyId: apiKeyId,
      twentyApiKeyToken: apiKeyToken,
      twentyApiKeyExpiresAt: expiresAt,
      passwordGenerated: password,
      initialMagicLinkUrl,
    };
  }

  /**
   * Étape 7 — régénération de magic link à la demande.
   *
   * Appelée depuis la route compagnon `/api/admin/crm/tenants/[id]/magic-link`
   * avec le password déchiffré depuis crm_tenants. Retourne une URL
   * `<workspaceUrl>/verify?loginToken=...` valide 15 min.
   */
  async regenerateMagicLink(args: {
    email: string;
    passwordDecrypted: string;
    workspaceUrl: string;
  }): Promise<{ magicLinkUrl: string; expiresAt: Date }> {
    if (!args.email || !args.passwordDecrypted || !args.workspaceUrl) {
      throw new CrmClientError('regenerateMagicLink: email/password/workspaceUrl required', {
        step: 'validate',
      });
    }

    const resp = await this.graphql<{
      getLoginTokenFromCredentials: {
        loginToken: { token: string; expiresAt: string };
      };
    }>({
      step: 'getLoginTokenFromCredentials',
      query: `
        mutation GetLoginToken($email: String!, $password: String!, $origin: String!) {
          getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) {
            loginToken { token expiresAt }
          }
        }
      `,
      variables: {
        email: args.email.trim().toLowerCase(),
        password: args.passwordDecrypted,
        origin: args.workspaceUrl,
      },
    });

    const token = resp.getLoginTokenFromCredentials?.loginToken?.token;
    const expiresAtStr = resp.getLoginTokenFromCredentials?.loginToken?.expiresAt;
    if (!token) {
      throw new CrmClientError('getLoginTokenFromCredentials: missing loginToken', {
        step: 'getLoginTokenFromCredentials',
        body: resp,
      });
    }

    return {
      magicLinkUrl: this.buildMagicLink(args.workspaceUrl, token),
      expiresAt: expiresAtStr ? new Date(expiresAtStr) : new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  /**
   * Push de leads via REST `/rest/people` du workspace cible.
   *
   * Batch séquentiel (Twenty REST n'expose pas de bulk natif en v2.8). On
   * collecte les erreurs par index plutôt que d'abort au premier échec —
   * cas d'usage "Robert pousse 100 leads, 2 échouent (email malformé), il
   * doit savoir lesquels".
   */
  async pushLeads(input: PushLeadInput): Promise<PushLeadResult> {
    if (!input.apiKey) throw new CrmClientError('pushLeads: apiKey required', { step: 'validate' });
    if (!input.workspaceUrl)
      throw new CrmClientError('pushLeads: workspaceUrl required', { step: 'validate' });

    const result: PushLeadResult = { pushed: 0, failed: 0, errors: [] };
    const restUrl = `${input.workspaceUrl.replace(/\/+$/, '')}/rest/people`;

    for (let i = 0; i < input.leads.length; i++) {
      const lead = input.leads[i];
      const body = {
        name: {
          firstName: lead.firstName ?? '',
          lastName: lead.lastName ?? '',
        },
        emails: lead.primaryEmail ? { primaryEmail: lead.primaryEmail } : undefined,
      };
      try {
        await this.restPost(restUrl, body, input.apiKey, 'pushLeads');
        result.pushed += 1;
      } catch (err) {
        result.failed += 1;
        result.errors.push({
          index: i,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private buildMagicLink(workspaceUrl: string, loginToken: string): string {
    const base = workspaceUrl.replace(/\/+$/, '');
    return `${base}/verify?loginToken=${encodeURIComponent(loginToken)}`;
  }

  private async graphql<T>(args: {
    step: string;
    query: string;
    variables?: Record<string, unknown>;
    bearer?: string;
  }): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (args.bearer) headers['Authorization'] = `Bearer ${args.bearer}`;
    const body = JSON.stringify({ query: args.query, variables: args.variables ?? {} });

    const response = await this.fetchWithRetry(this.metadataUrl, {
      method: 'POST',
      headers,
      body,
      step: args.step,
    });

    type GraphQLResponse = { data?: T; errors?: Array<{ message: string }> };
    let parsed: GraphQLResponse | null = null;
    try {
      parsed = (await response.json()) as GraphQLResponse;
    } catch (err) {
      throw new CrmClientError(
        `${args.step}: failed to parse GraphQL response — ${
          err instanceof Error ? err.message : String(err)
        }`,
        { step: args.step, status: response.status },
      );
    }

    if (parsed?.errors?.length) {
      throw new CrmClientError(
        `${args.step}: GraphQL error — ${parsed.errors.map((e) => e.message).join('; ')}`,
        { step: args.step, status: response.status, body: parsed.errors },
      );
    }
    if (!parsed?.data) {
      throw new CrmClientError(`${args.step}: GraphQL response missing 'data'`, {
        step: args.step,
        status: response.status,
        body: parsed,
      });
    }
    return parsed.data;
  }

  private async restPost(
    url: string,
    body: unknown,
    bearer: string,
    step: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    };
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      step,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CrmClientError(
        `${step}: REST ${response.status} ${response.statusText} — ${text.slice(0, 200)}`,
        { step, status: response.status },
      );
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit & { step: string },
  ): Promise<Response> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        clearTimeout(timer);
        // Retry uniquement sur 5xx
        if (response.status >= 500 && response.status < 600 && attempt < this.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        return response;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < this.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          throw new CrmClientError(
            `${init.step}: request timed out after ${this.timeoutMs}ms`,
            { step: init.step },
          );
        }
        throw new CrmClientError(
          `${init.step}: network error — ${err instanceof Error ? err.message : String(err)}`,
          { step: init.step },
        );
      }
    }
    throw lastErr ?? new CrmClientError(`${init.step}: unknown error`, { step: init.step });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 4000);
}

/**
 * Factory paresseuse — instancie un CrmClient configuré depuis les ENV
 * standards Veridian Hub. Pratique pour les routes admin qui n'ont rien
 * à customiser.
 */
export function createCrmClientFromEnv(opts?: Partial<CrmClientOptions>): CrmClient {
  const metadataUrl = process.env.CRM_METADATA_URL;
  const restUrl = process.env.CRM_REST_URL;
  const frontendUrl = process.env.CRM_FRONTEND_URL;
  if (!metadataUrl || !restUrl || !frontendUrl) {
    throw new Error(
      'CRM_METADATA_URL, CRM_REST_URL and CRM_FRONTEND_URL must all be set',
    );
  }
  return new CrmClient({
    metadataUrl,
    restUrl,
    frontendUrl,
    ...opts,
  });
}

/**
 * Helper haut-niveau consommé par la route user dashboard
 * `/api/dashboard/crm/regenerate-magic-link` : prend juste l'identifiant
 * du CrmTenant Hub, fait l'orchestration complète (lookup → decrypt →
 * appel GraphQL Twenty étape 7).
 *
 * Distinct de `CrmClient.regenerateMagicLink` qui est l'appel de bas niveau
 * (signature riche email/password/workspaceUrl) — celle-ci s'occupe de
 * tout, donc 1 seul argument côté caller.
 *
 * @throws Error si tenant introuvable / deleted / pas actif.
 * @throws CrmClientError si l'appel CRM échoue.
 */
export async function regenerateMagicLink(
  crmTenantId: string,
): Promise<{ magicLinkUrl: string; expiresAt: Date }> {
  // Imports paresseux pour éviter le cycle d'import + permettre mock
  // facile (vi.mock du module au top-level reste fonctionnel).
  const { getCrmTenantById } = await import('./select-tenant');
  const { decryptSecret } = await import('./vault');

  const tenant = await getCrmTenantById(crmTenantId);
  if (!tenant) {
    throw new Error(`CrmTenant ${crmTenantId} not found`);
  }
  if (tenant.status === 'deleted') {
    throw new Error(`CrmTenant ${crmTenantId} is deleted`);
  }
  if (tenant.status !== 'active') {
    throw new Error(`CrmTenant ${crmTenantId} is not active (status=${tenant.status})`);
  }
  const password = decryptSecret(tenant.twentyPasswordEncrypted);
  const client = createCrmClientFromEnv();
  return client.regenerateMagicLink({
    email: tenant.email,
    passwordDecrypted: password,
    workspaceUrl: tenant.twentyWorkspaceUrl,
  });
}
