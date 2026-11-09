/**
 * Liens « Ajouter à … » de la porte MCP : une seule adresse pour toutes les apps Veridian, le client
 * IA fait ensuite l'OAuth du Hub (découverte, enregistrement, consentement). Aucun secret dans ces liens.
 *
 * - Claude (claude.ai, Desktop, mobile) : lien officiel qui ouvre « Ajouter un connecteur personnalisé »
 *   prérempli, l'utilisateur confirme (claude.com/docs/connectors/building/directory-vs-custom).
 * - ChatGPT : aucun lien de préremplissage n'existe (09/11/2026) ; on ouvre la page des plugins et on
 *   donne l'adresse à coller.
 * - Cursor : lien d'installation officiel, configuration en JSON base64 (cursor.com/docs/mcp/install-links).
 * - VS Code : lien `vscode:mcp/install`, configuration en JSON encodé dans l'URL.
 * - Claude Code : une commande.
 */
import { mcpResource } from './config';

export const NOM_CONNECTEUR = 'Veridian';

export type LiensInstallation = {
  url: string;
  claude: string;
  chatgpt: string;
  cursor: string;
  vscode: string;
  claudeCode: string;
};

export function liensInstallation(env: NodeJS.ProcessEnv = process.env): LiensInstallation {
  const url = mcpResource(env);
  const claude =
    `https://claude.ai/customize/connectors?modal=add-custom-connector` +
    `&connectorName=${encodeURIComponent(NOM_CONNECTEUR)}&connectorUrl=${encodeURIComponent(url)}`;
  const cursorConfig = Buffer.from(JSON.stringify({ url })).toString('base64');
  const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(NOM_CONNECTEUR.toLowerCase())}&config=${encodeURIComponent(cursorConfig)}`;
  const vscodeConfig = encodeURIComponent(JSON.stringify({ name: NOM_CONNECTEUR.toLowerCase(), type: 'http', url }));
  // Passé par vscode.dev/redirect : un lien `vscode:` brut est bloqué par certains navigateurs et webmails.
  const vscode = `https://vscode.dev/redirect?url=${encodeURIComponent(`vscode:mcp/install?${vscodeConfig}`)}`;
  return {
    url,
    claude,
    chatgpt: 'https://chatgpt.com/plugins',
    cursor,
    vscode,
    claudeCode: `claude mcp add --transport http ${NOM_CONNECTEUR.toLowerCase()} ${url}`,
  };
}
