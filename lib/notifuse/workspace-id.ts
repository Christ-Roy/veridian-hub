/**
 * Validation et génération de `workspace_id` Notifuse.
 *
 * Contraintes du fork Notifuse Veridian (cf `internal/database/schema/...`) :
 *  - Type SQL : `varchar(20)` → max 20 chars
 *  - Charset accepté : `[a-z0-9]` (lowercase alphanumérique uniquement,
 *    pas d'underscore, hyphen ou majuscule en pratique côté Go path)
 *  - Pas de wildcards SQL ni de string vide
 *
 * Tout ce qui touche à un workspace_id Notifuse côté Hub doit passer par
 * ces helpers — sinon on a des écarts de validation entre routes (déjà
 * arrivé : deux routes, deux longueurs).
 */

import { createHash } from 'node:crypto';

import { estCompteDeTest } from '@/lib/email/compte-de-test';
import { isTestAccount } from '@/lib/sync/test-residue';

export const NOTIFUSE_WORKSPACE_ID_MAX_LENGTH = 20;

/** Préfixe des comptes d'épreuve : leurs espaces se comptent et se retirent par lui. */
const prefixe = (email: string): string => (estCompteDeTest(email) ? 'e2esso' : isTestAccount(email) ? 'e2e' : 'v');

/**
 * L'identifiant de l'espace Mail d'un tenant : choisi par le Hub, tiré de l'id du tenant, jamais de l'adresse. Le même à chaque rejeu et dans deux
 * provisionnements qui se croisent ; jamais celui d'un autre. Avant le 25/11 c'était le début de l'adresse coupé à 20 caractères : contact@a.fr et
 * contact@b.fr visaient le même espace, et qui choisissait son adresse choisissait l'espace visé. Les espaces déjà là gardent le leur.
 */
export function workspaceIdDuTenant(hubTenantId: string, email: string): string {
  const p = prefixe(email);
  const h = BigInt(`0x${createHash('sha256').update(`notifuse:${hubTenantId}`).digest('hex')}`).toString(36);
  return (p + h).slice(0, NOTIFUSE_WORKSPACE_ID_MAX_LENGTH);
}

export interface WorkspaceIdValidation {
  ok: boolean;
  error?: string;
}

/**
 * Valide qu'un workspace_id fourni par un client respecte les contraintes
 * Notifuse. Retourne `{ ok: true }` ou `{ ok: false, error }`.

 */
export function validateWorkspaceId(value: unknown): WorkspaceIdValidation {
  if (typeof value !== 'string' || !value) {
    return { ok: false, error: 'workspaceId required (non-empty string)' };
  }
  if (!/^[a-z0-9]+$/.test(value)) {
    return {
      ok: false,
      error:
        'workspaceId must be lowercase alphanumeric only (no spaces, underscores, hyphens or uppercase)',
    };
  }
  if (value.length > NOTIFUSE_WORKSPACE_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `workspaceId must be ${NOTIFUSE_WORKSPACE_ID_MAX_LENGTH} characters or less (got ${value.length})`,
    };
  }
  return { ok: true };
}
