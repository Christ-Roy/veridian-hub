/**
 * Provisioning du CRM Veridian (fork Twenty) depuis le Hub, CONTRAT-HUB §5.1 et §3.8.
 *
 * Le contrat est commun aux apps à espace par utilisateur : `lib/apps/espace-app.ts`. Ce fichier garde
 * les noms historiques utilisés par l'activation, le rebond et la porte MCP.
 */
import type { PrismaClient } from '@prisma/client';

import {
  ensureAppWorkspace,
  ESPACE_APPS,
  provisionAppWorkspace,
  type EspaceProvisionInput,
  type EspaceProvisionResult,
} from '@/lib/apps/espace-app';

export type CrmProvisionInput = EspaceProvisionInput;
export type CrmProvisionResult = EspaceProvisionResult;

export function provisionCrmWorkspace(
  input: CrmProvisionInput,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): Promise<CrmProvisionResult> {
  return provisionAppWorkspace(ESPACE_APPS.crm, input, opts);
}

/**
 * Garantit l'espace CRM d'un utilisateur à adresse prouvée : à l'activation admin et à la première
 * ouverture (rebond refusé `user_not_in_app`). Le Hub retient l'espace dans `metadata.crm`, que
 * reconcile lit, et active l'app `twenty` pour que la carte du tableau de bord reste juste.
 */
export function ensureCrmWorkspace(
  db: Pick<PrismaClient, 'tenant' | 'tenantApp' | 'tenantTrial' | 'subscription' | '$executeRaw'>,
  user: { hubUserId: string; email: string; name?: string | null },
  opts: { actorEmail?: string | null; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<CrmProvisionResult> {
  return ensureAppWorkspace(ESPACE_APPS.crm, db, user, opts);
}
