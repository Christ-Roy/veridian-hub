/**
 * Liens « Ajouter à … » de la porte MCP : une seule adresse pour toutes les apps Veridian, le client
 * IA fait ensuite l'OAuth du Hub (découverte, enregistrement, consentement). Aucun secret dans ces liens.
 *
 * - Claude (claude.ai, Desktop, mobile) : lien officiel qui ouvre « Ajouter un connecteur personnalisé »
 *   prérempli, l'utilisateur confirme (claude.com/docs/connectors/building/directory-vs-custom).
 * - ChatGPT : aucun lien de préremplissage n'existe (09/11/2026) ; on ouvre Paramètres → Plugins et on
 *   donne l'adresse à coller.
 * - Cursor : lien d'installation officiel, configuration en JSON base64 (cursor.com/docs/mcp/install-links).
 * - VS Code : lien `vscode:mcp/install`, configuration en JSON encodé dans l'URL.
 * - Claude Code : une commande.
 */
import type { PrismaClient } from '@prisma/client';

import { mcpResource } from './config';

export const NOM_CONNECTEUR = 'Veridian';

export type LiensInstallation = {
  url: string;
  claude: string;
  chatgpt: string;
  cursor: string;
  vscode: string;
  claudeCode: string;
  instructions: { chatgpt: string };
};

/** ChatGPT n'a pas de lien qui préremplit : ce texte accompagne le bouton, dans le Hub comme dans les apps. */
export const INSTRUCTIONS_CHATGPT =
  "Dans ChatGPT (Paramètres, Plugins) : ajoutez un serveur MCP, collez l'adresse Veridian et choisissez " +
  "l'authentification OAuth. Si l'option n'apparaît pas, activez le mode développeur dans Paramètres, " +
  'Sécurité et connexion.';

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
    // Mène à Paramètres → Plugins (vérifié dans un navigateur le 09/11) ; /plugins seul n'ouvrait rien.
    chatgpt: 'https://chatgpt.com/#settings/Connectors',
    cursor,
    vscode,
    claudeCode: `claude mcp add --transport http ${NOM_CONNECTEUR.toLowerCase()} ${url}`,
    instructions: { chatgpt: INSTRUCTIONS_CHATGPT },
  };
}

export type Assistant = {
  cle: 'claude' | 'chatgpt' | 'cursor' | 'vscode';
  libelle: string;
  /** Lien qui ouvre l'ajout du connecteur (prérempli sauf ChatGPT). */
  installation: string;
  /** L'étape à suivre quand le lien ne préremplit pas, sinon null. */
  etape: string | null;
};

export function assistants(l: LiensInstallation): Assistant[] {
  return [
    { cle: 'claude', libelle: 'Ajouter à Claude', installation: l.claude, etape: null },
    { cle: 'chatgpt', libelle: 'Ouvrir ChatGPT', installation: l.chatgpt, etape: l.instructions.chatgpt },
    { cle: 'cursor', libelle: 'Ajouter à Cursor', installation: l.cursor, etape: null },
    { cle: 'vscode', libelle: 'Ajouter à VS Code', installation: l.vscode, etape: null },
  ];
}

/**
 * Réponse publique de `GET /api/mcp/liens-installation[?app=<cle>]`. `app` (une clé du registre) met en
 * avant l'app qui affiche les boutons ; le connecteur reste « Veridian », un seul pour toutes les apps
 * (un connecteur par app en créerait plusieurs chez l'utilisateur). Clé inconnue ou coupée : `app: null`.
 */
export async function liensPublics(db: Pick<PrismaClient, 'mcpApp'>, appKey: string | null, env: NodeJS.ProcessEnv = process.env) {
  const l = liensInstallation(env);
  let app: { cle: string; nom: string; phrase: string } | null = null;
  if (appKey && /^[a-z0-9-]{1,40}$/.test(appKey)) {
    const ligne = await db.mcpApp.findUnique({ where: { appKey } });
    if (ligne?.enabled) {
      app = {
        cle: ligne.appKey,
        nom: ligne.label,
        phrase: `Une seule connexion Veridian : votre IA accède à ${ligne.label} et à vos autres apps Veridian.`,
      };
    }
  }
  return { ...l, assistants: assistants(l), app };
}
