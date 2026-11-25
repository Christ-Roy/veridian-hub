/**
 * Services extérieurs qu'une personne relie à son compte (VER-119, VER-244). Chacun publie un serveur MCP protégé par OAuth et accepte qu'un client
 * s'enregistre seul : aucune application à créer chez lui, aucun coût, ni pour Veridian ni pour la personne. L'adresse est figée ici, jamais reçue.
 * N'y entre jamais un service qui déplace de l'argent, ni un service dont l'écran de consentement n'a pas été VU (Canva, 25/11 : il enregistre notre client
 * puis refuse notre adresse de retour).
 */
export type Connecteur = { cle: string; nom: string; texte: string; mcpUrl: string; /** Portée demandée ; absente : celle que le service annonce. */ portee?: string };

export const CONNECTEURS: readonly Connecteur[] = [
  { cle: 'notion', nom: 'Notion', texte: 'Pages, bases et recherche de votre espace Notion.', mcpUrl: 'https://mcp.notion.com/mcp' },
  { cle: 'linear', nom: 'Linear', texte: 'Tickets, projets et équipes Linear.', mcpUrl: 'https://mcp.linear.app/mcp' },
  { cle: 'webflow', nom: 'Webflow', texte: 'Vos sites et contenus Webflow.', mcpUrl: 'https://mcp.webflow.com/mcp' },
  { cle: 'sentry', nom: 'Sentry', texte: 'Erreurs et projets Sentry.', mcpUrl: 'https://mcp.sentry.dev/mcp' },
];

export const connecteur = (cle: unknown): Connecteur | null => CONNECTEURS.find((c) => c.cle === cle) ?? null;
