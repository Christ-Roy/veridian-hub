/** Constantes de la porte MCP du Hub (docs/CONTRAT-MCP.md). */

export const MCP_SCOPE = 'veridian';
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86400;
export const CODE_TTL_S = 600;
export const DOWNSTREAM_TTL_S = 300;
/** Plafond de texte rendu au client par appel d'outil. */
export const SORTIE_MAX_CAR = 16_000;
export const PROTOCOLES = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

/** Émetteur OAuth = l'origine publique du Hub. */
export function hubIssuer(env: NodeJS.ProcessEnv = process.env): string {
  const brut = env.AUTH_URL || env.NEXT_PUBLIC_SITE_URL || 'https://app.veridian.site';
  return brut.replace(/\/+$/, '');
}

/** La ressource protégée (RFC 8707) : l'adresse de la porte. */
export function mcpResource(env: NodeJS.ProcessEnv = process.env): string {
  return `${hubIssuer(env)}/api/mcp`;
}

export function resourceMetadataUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${hubIssuer(env)}/.well-known/oauth-protected-resource`;
}

export function authorizationServerMetadata(env: NodeJS.ProcessEnv = process.env) {
  const iss = hubIssuer(env);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    registration_endpoint: `${iss}/api/oauth/register`,
    revocation_endpoint: `${iss}/api/oauth/revoke`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(env: NodeJS.ProcessEnv = process.env) {
  return {
    resource: mcpResource(env),
    authorization_servers: [hubIssuer(env)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Veridian',
  };
}

/** En-têtes CORS des points publics OAuth (aucun cookie n'y est lu). */
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
} as const;
