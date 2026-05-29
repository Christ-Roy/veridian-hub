/**
 * Types pour le client CRM (Twenty fork) — Veridian Hub side.
 *
 * Source : ticket `todo/2026-05-27-route-admin-create-crm-tenant.md`
 * (flow 6 GraphQL calls validé staging 2026-05-27).
 */

export class CrmClientError extends Error {
  readonly name = 'CrmClientError';
  readonly step?: string;
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, opts: { step?: string; status?: number; body?: unknown } = {}) {
    super(message);
    this.step = opts.step;
    this.status = opts.status;
    this.body = opts.body;
  }
}

export interface CreateCrmTenantInput {
  email: string;
  workspaceName: string;
}

export interface CreateCrmTenantResult {
  twentyWorkspaceId: string;
  twentyWorkspaceUrl: string;
  twentyApiKeyId: string;
  /** Bearer JWT type=API_KEY (~600 chars). À chiffrer par le caller. */
  twentyApiKeyToken: string;
  twentyApiKeyExpiresAt: Date;
  /** Random 32B base64url. À chiffrer par le caller. Jamais affiché. */
  passwordGenerated: string;
  /** Magic link prêt à donner à l'user (TTL 15 min). */
  initialMagicLinkUrl: string;
}

export interface PushLeadInput {
  /** Bearer Twenty API key DÉCHIFFRÉ (long-lived 1 an). */
  apiKey: string;
  /** URL workspace (ex: `https://acme.crm.staging.veridian.site`). */
  workspaceUrl: string;
  leads: Array<{
    firstName?: string;
    lastName?: string;
    primaryEmail?: string;
    [k: string]: unknown;
  }>;
}

export interface PushLeadResult {
  pushed: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
}
