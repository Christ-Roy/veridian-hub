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
 * arrivé : `provision.ts` slice 20 vs `create-tenant/route.ts` valide 32).
 */

export const NOTIFUSE_WORKSPACE_ID_MAX_LENGTH = 20;

/**
 * Génère un workspace_id valide depuis un email. Applique :
 *  - split sur `@` (prend le local-part)
 *  - retire tout caractère non `[a-z0-9]` (case-insensitive puis lowercase)
 *  - tronque à 20 chars
 *
 * Si le résultat est vide (email exotique tout en symboles), throw.
 */
export function workspaceIdFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const truncated = cleaned.slice(0, NOTIFUSE_WORKSPACE_ID_MAX_LENGTH);
  if (!truncated) {
    throw new Error(
      `Cannot derive Notifuse workspace_id from email "${email}" — local-part has no alphanumeric characters`,
    );
  }
  return truncated;
}

export interface WorkspaceIdValidation {
  ok: boolean;
  error?: string;
}

/**
 * Valide qu'un workspace_id fourni par un client respecte les contraintes
 * Notifuse. Retourne `{ ok: true }` ou `{ ok: false, error }`.
 *
 * Utiliser ça côté routes API qui acceptent un workspaceId user-fourni
 * (création manuelle), pas pour ceux dérivés via `workspaceIdFromEmail()`.
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
