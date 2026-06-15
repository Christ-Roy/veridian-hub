/**
 * Types miroir des contrats Go pour les endpoints Notifuse Veridian-aware.
 * Voir docs/saas-standards.md §6 (Provisioning API) pour le contrat HMAC.
 */

/**
 * Plans Notifuse supportés par le fork Veridian.
 * Doit rester aligné avec `internal/domain/veridian.go` (`PlanQuotas` map) côté Go.
 *
 * - free / pro / business / enterprise : plans payants ou freemium standards (Stripe-driven).
 * - lifetime_site_vitrine / lifetime_partner : plans offerts à vie aux clients
 *   sites vitrines Veridian ou aux partenaires, NON liés à une subscription Stripe.
 * - internal : tenants internes Robert (test, demo, support). Quota illimité.
 */
export type NotifusePlan =
  | 'free'
  | 'pro'
  | 'business'
  | 'enterprise'
  | 'lifetime_site_vitrine'
  | 'lifetime_partner'
  | 'internal';

/**
 * Liste runtime des plans valides — utilisable côté validation route admin.
 * Mise à jour à chaque ajout dans le union NotifusePlan.
 */
export const NOTIFUSE_PLANS: readonly NotifusePlan[] = [
  'free',
  'pro',
  'business',
  'enterprise',
  'lifetime_site_vitrine',
  'lifetime_partner',
  'internal',
] as const;

export function isNotifusePlan(value: unknown): value is NotifusePlan {
  return typeof value === 'string' && (NOTIFUSE_PLANS as readonly string[]).includes(value);
}

export interface ProvisionInput {
  tenantId: string;
  ownerEmail: string;
  workspaceName?: string;
  plan?: NotifusePlan;
}

export interface ProvisionResponse {
  workspace_id: string;
  owner_user_id: string;
  api_key: string;
  api_key_email: string;
  /** Fallback magic link `/console/signin?email=X&code=Y` (saisie manuelle code). */
  magic_link: string;
  /** Self-contained URL `/veridian/auto-login?token=<HMAC>` qui logge directement
   * le user via localStorage (TTL 60s). C'est l'URL que le Hub utilise pour
   * son bouton "Open Notifuse" sans saisie. */
  auto_login_url: string;
  plan: NotifusePlan;
  created: boolean;
}

export interface UpdatePlanInput {
  tenantId: string;
  plan: NotifusePlan;
}

export interface SuspendInput {
  tenantId: string;
  reason?: string;
}

export interface ResumeInput {
  tenantId: string;
}

export interface StatusResponse {
  tenant_id: string;
  status: 'active' | 'suspended' | 'deleted';
  plan: NotifusePlan;
  monthly_email_quota: number;
  emails_sent_this_month: number;
  quota_remaining: number;
  suspended_at?: string;
  suspended_reason?: string;
  deleted_at?: string;
  quota_resets_at?: string;
}

export interface MagicLinkInput {
  apiKey: string;
  userEmail: string;
}

export interface MagicLinkResponse {
  magic_link: string;
  /** Self-contained auto-login URL (préférée — pas de saisie de code). */
  auto_login_url: string;
  expires_at: string;
}

/**
 * Réparation d'un workspace existant : attache un user humain comme owner.
 * Idempotent + additif (ne retire jamais d'owner existant).
 *
 * Endpoint Notifuse : POST /api/veridian/admin/attach-owner (HMAC Hub).
 * Cf notifuse-veridian/todo/done/2026-05-17-provision-owner-attach.md.
 */
export interface AttachOwnerInput {
  tenantId: string;
  ownerEmail: string;
  /** "owner" par défaut côté Notifuse si omis. */
  role?: 'owner' | 'admin';
}

export interface AttachOwnerResponse {
  tenant_id: string;
  owner_email: string;
  /** ID interne Notifuse du user (créé ou existant). */
  user_id: string;
  /** true si la ligne user_workspaces a été créée/modifiée ce tour-ci. */
  attached: boolean;
  /** true si le user était déjà attaché avec le bon role (no-op). */
  already_attached: boolean;
  /** true si Notifuse a transféré l'ownership d'un autre user vers ce user. */
  owner_transferred?: boolean;
  /** "owner" ou "admin" — role effectif après l'opération. */
  role: 'owner' | 'admin';
}

/**
 * Health check observable d'un tenant côté Notifuse.
 * Endpoint : GET /api/tenants/{id}/health (HMAC Hub).
 */
export interface HealthResponse {
  tenant_id: string;
  workspace_id: string;
  status: 'active' | 'suspended' | 'deleted';
  /** true si un user humain (`type=user`) est attaché au workspace. */
  owner_attached: boolean;
  /** Email de l'owner humain actuel côté Notifuse (peut différer du Hub si désync). */
  owner_email: string | null;
  owner_user_id: string | null;
  api_key_valid: boolean;
  /** false si owner_attached=false OU api_key_valid=false OU status=deleted. */
  magic_link_capable: boolean;
  members_count: number;
  plan: NotifusePlan;
  /** ISO8601 — timestamp côté Notifuse au moment du check. */
  checked_at: string;
}

export type NotifuseEventType =
  | 'tenant.provisioned'
  | 'tenant.suspended'
  | 'tenant.resumed'
  | 'tenant.deleted'
  | 'tenant.quota_exceeded'
  | 'email.sent'
  // Events COMPORTEMENTAUX (réconciliateur cold↔web, 2026-06-15). Émis par le
  // fork Notifuse via la voie LEGACY HMAC. Cf docs/CONTRAT-HUB.md §7.5.
  | 'email.opened'
  | 'email.clicked'
  | 'email.replied';

export interface VeridianEventPayload<T = unknown> {
  event_id: string;
  event_type: NotifuseEventType;
  tenant_id: string;
  occurred_at: string;
  data: T;
}

export interface TenantSuspendedEventData {
  suspended_at: string;
  reason?: string;
}

export interface TenantResumedEventData {
  resumed_at: string;
}

export interface TenantDeletedEventData {
  deleted_at: string;
}

export interface EmailSentEventData {
  message_id: string;
  to: string;
  sent_at: string;
}

export interface QuotaExceededEventData {
  monthly_email_quota: number;
  emails_sent_this_month: number;
}

/**
 * `data` d'un event comportemental cold (email.opened/clicked/replied).
 * `contact_email` = clé de jointure prospect V1. `vid` = ID prospect
 * déterministe cross-app (étage 2, optionnel). Champs additionnels libres
 * (message_id, link_url, ...) conservés dans le JSONB ProspectEvent.data.
 */
export interface BehavioralEventData {
  contact_email?: string;
  vid?: string;
  message_id?: string;
  link_url?: string;
  occurred_at?: string;
  [key: string]: unknown;
}

export class NotifuseError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'NotifuseError';
  }
}
