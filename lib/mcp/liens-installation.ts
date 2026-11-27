/**
 * Liens « Ajouter à … » de la porte MCP : une seule adresse pour toutes les apps Veridian, le client
 * IA fait ensuite l'OAuth du Hub (découverte, enregistrement, consentement). Aucun secret dans ces liens.
 *
 * - Claude (claude.ai, Desktop, mobile) : lien officiel qui ouvre « Ajouter un connecteur personnalisé »
 *   prérempli, l'utilisateur confirme (claude.com/docs/connectors/building/directory-vs-custom).
 * - ChatGPT : aucun lien de préremplissage n'existe ; on ouvre la page Plugins et on donne l'adresse à coller. Chemin lu le 25/11/2026 sur
 *   developers.openai.com/apps-sdk/deploy/connect-chatgpt, developer-mode et help.openai.com 12584461 ; pas vu sur un vrai compte.
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
  'Dans ChatGPT sur le web, page Plugins (chatgpt.com/plugins) : bouton +, puis « Add custom MCP server » ; collez l\'adresse Veridian, ' +
  'choisissez l\'authentification OAuth, acceptez l\'avertissement, puis « Create as a plugin » et installez le plugin. ' +
  'Selon votre offre, un administrateur de votre espace ChatGPT peut devoir l\'autoriser.';

/** Les langues des libellés servis aux apps (Mail, 27/11 : une console anglaise affichait les boutons en français). */
export type Langue = 'fr' | 'en';
const TEXTES: Record<Langue, { claude: string; chatgpt: string; cursor: string; vscode: string; etapeChatgpt: string; phrase: (app: string) => string }> = {
  fr: {
    claude: 'Ajouter à Claude', chatgpt: 'Ouvrir ChatGPT', cursor: 'Ajouter à Cursor', vscode: 'Ajouter à VS Code', etapeChatgpt: INSTRUCTIONS_CHATGPT,
    phrase: (app) => `Une seule connexion Veridian : votre IA accède à ${app} et à vos autres apps Veridian.`,
  },
  en: {
    claude: 'Add to Claude', chatgpt: 'Open ChatGPT', cursor: 'Add to Cursor', vscode: 'Add to VS Code',
    etapeChatgpt:
      'In ChatGPT on the web, Plugins page (chatgpt.com/plugins): the + button, then “Add custom MCP server”; paste the Veridian address, ' +
      'choose OAuth authentication, accept the warning, then “Create as a plugin” and install the plugin. ' +
      'Depending on your plan, an administrator of your ChatGPT workspace may need to allow it.',
    phrase: (app) => `One Veridian connection: your AI reaches ${app} and your other Veridian apps.`,
  },
};
/** `?lang=fr|en` d'abord, puis la première langue d'Accept-Language ; le français par défaut. */
export function langueDe(param: string | null, acceptLanguage: string | null): Langue {
  const p = (param ?? '').toLowerCase();
  if (p === 'fr' || p === 'en') return p;
  return /^\s*en\b/i.test(acceptLanguage ?? '') ? 'en' : 'fr';
}

export function liensInstallation(env: NodeJS.ProcessEnv = process.env, langue: Langue = 'fr'): LiensInstallation {
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
    // La doc d'OpenAI part de cette page (25/11). Le 09/11, /plugins n'ouvrait rien : l'étape nomme aussi l'adresse et les boutons.
    chatgpt: 'https://chatgpt.com/plugins',
    cursor,
    vscode,
    claudeCode: `claude mcp add --transport http ${NOM_CONNECTEUR.toLowerCase()} ${url}`,
    instructions: { chatgpt: TEXTES[langue].etapeChatgpt },
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

export function assistants(l: LiensInstallation, langue: Langue = 'fr'): Assistant[] {
  const t = TEXTES[langue];
  return [
    { cle: 'claude', libelle: t.claude, installation: l.claude, etape: null },
    { cle: 'chatgpt', libelle: t.chatgpt, installation: l.chatgpt, etape: l.instructions.chatgpt },
    { cle: 'cursor', libelle: t.cursor, installation: l.cursor, etape: null },
    { cle: 'vscode', libelle: t.vscode, installation: l.vscode, etape: null },
  ];
}

/**
 * Réponse publique de `GET /api/mcp/liens-installation[?app=<cle>]`. `app` (une clé du registre) met en
 * avant l'app qui affiche les boutons ; le connecteur reste « Veridian », un seul pour toutes les apps
 * (un connecteur par app en créerait plusieurs chez l'utilisateur). Clé inconnue ou coupée : `app: null`.
 */
export async function liensPublics(db: Pick<PrismaClient, 'mcpApp'>, appKey: string | null, env: NodeJS.ProcessEnv = process.env, langue: Langue = 'fr') {
  const l = liensInstallation(env, langue);
  let app: { cle: string; nom: string; phrase: string } | null = null;
  if (appKey && /^[a-z0-9-]{1,40}$/.test(appKey)) {
    const ligne = await db.mcpApp.findUnique({ where: { appKey } });
    if (ligne?.enabled) {
      app = {
        cle: ligne.appKey,
        nom: ligne.label,
        phrase: TEXTES[langue].phrase(ligne.label),
      };
    }
  }
  return { ...l, assistants: assistants(l, langue), app, langue };
}
