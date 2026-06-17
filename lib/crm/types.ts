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

// ─── Écriture Twenty par tenant (parité bridge §4c) ────────────────────────
//
// Les méthodes d'écriture (resolve/batchTimeline/patchPerson/opportunity)
// taquent le workspace Twenty SPÉCIFIQUE d'un tenant, pas l'endpoint admin
// global de provisioning. Comme `pushLeads`, elles reçoivent le contexte
// tenant explicitement (`TwentyWriteContext`) plutôt que de figer un Bearer
// au constructeur : un seul CrmClient peut donc servir N tenants dans un run
// de cron, chacun avec son workspaceUrl + Bearer déchiffré.

/** Contexte d'écriture pour UN workspace Twenty (un tenant). */
export interface TwentyWriteContext {
  /** URL workspace, ex `https://acme.crm.veridian.site` (REST sous /rest/*). */
  baseUrl: string;
  /** Bearer Twenty API key DÉCHIFFRÉ (long-lived) du tenant. */
  bearer: string;
}

/**
 * Une timeline activity à écrire (digest/jalon §4c.3 — jamais le flux brut).
 * `name` ∈ email.* | audit.* | score.threshold | signup | app.started.
 */
export interface TimelineActivityInput {
  /** Nom FIGÉ §4c.3 (namespace.verbe). */
  name: string;
  /** ISO UTC = heure VRAIE de l'event (jamais l'heure d'écriture). */
  happensAt: string;
  /** Person cible (résolue en amont). */
  targetPersonId: string;
  /** Trace d'audit §4.3 (eventId, source, broadcastId?, …). */
  properties: Record<string, unknown>;
}

/** Person résolue par email/slug — §4c.1. */
export interface ResolvedPerson {
  id: string;
  /** Le stage vit sur l'Opportunity, pas la Person — toujours null ici. */
  stage: string | null;
  doNotContact: boolean;
}

/** Opportunity dont la Person est point de contact (import batch → NEW). */
export interface OpportunityRef {
  id: string;
  /** values §4b : NEW | SCREENING | MEETING | PROPOSAL | CUSTOMER. */
  stage: string;
}
