// STUB temporaire — Agent A doit livrer la vraie version (appel GraphQL
// Twenty pour générer un magic-link ou regénérer la session). Cette stub
// existe pour que la route /api/dashboard/crm/regenerate-magic-link
// compile et que les tests passent en parallèle.
//
// Quand Agent A push :
// - GraphQL mutation Twenty `generateSignInUrl(workspaceId)` ou équivalent
// - Retourne URL temporaire signée, expire 15min côté Twenty
// - Lit `apiKeyEncrypted` du CrmTenant, déchiffre, appelle Twenty avec Bearer
//
// Le shape exporté ci-dessous est le contrat consommé par la route.

export interface MagicLinkResult {
  magicLinkUrl: string;
  expiresAt: Date;
}

export async function regenerateMagicLink(
  _crmTenantId: string,
): Promise<MagicLinkResult> {
  // TODO(agent-A): brancher sur GraphQL Twenty
  throw new Error(
    '[lib/crm/client] regenerateMagicLink not implemented yet — waiting for Agent A',
  );
}
