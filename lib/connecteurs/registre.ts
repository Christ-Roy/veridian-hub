/**
 * Services extérieurs qu'une personne relie à son compte (VER-119, VER-244). Chacun publie un serveur MCP protégé par OAuth et accepte qu'un client
 * s'enregistre seul : aucune application à créer chez lui, aucun coût, ni pour Veridian ni pour la personne. Tout est figé ici, rien n'est reçu : l'adresse
 * du service, les hôtes où l'on s'autorise, prend un jeton, s'inscrit et révoque, et chaque outil servi, avec l'empreinte de la définition relue.
 * N'y entre jamais un service qui déplace de l'argent, ni un service dont l'écran de consentement n'a pas été VU (Canva, 25/11 : il enregistre notre client
 * puis refuse notre adresse de retour).
 */
export type Acces = 'lecture' | 'ecriture';
/** `empreinte` : celle de la définition entière (nom, titre, description, paramètres, annonces), relue par nous. Elle change, l'outil n'est plus servi. */
export type OutilRelu = { acces: Acces; empreinte: string };
/** Des hôtes (`hôte` ou `hôte:port`), sauf l'émetteur, une adresse. `revocation` absente : le service n'en publie pas. */
export type HotesOAuth = { emetteur: string; autorisation: string; jeton: string; enregistrement: string; revocation: string };
export type Connecteur = {
  cle: string; nom: string; texte: string; mcpUrl: string; oauth: HotesOAuth; outils: Readonly<Record<string, OutilRelu>>; /** Portée demandée ; absente : celle que le service annonce. */ portee?: string;
};

/** Les quatre s'autorisent chez eux, sur l'hôte même de leur serveur MCP. Un autre hôte annoncé un jour : refus, jamais suivi. */
const chezLui = (hote: string): HotesOAuth => ({ emetteur: `https://${hote}`, autorisation: hote, jeton: hote, enregistrement: hote, revocation: hote });

/**
 * `outils` vides : aucune définition n'a été lue, il faut une vraie connexion (geste de Robert). Jusque-là RIEN n'est servi, même relié. Ce que le service
 * annonce se relève dans `connecteur_outils_vus` (GET /api/admin/connecteurs), se relit, puis s'inscrit ici.
 */
export const CONNECTEURS: readonly Connecteur[] = [
  { cle: 'notion', nom: 'Notion', texte: 'Pages, bases et recherche de votre espace Notion.', mcpUrl: 'https://mcp.notion.com/mcp', oauth: chezLui('mcp.notion.com'), outils: {} },
  { cle: 'linear', nom: 'Linear', texte: 'Tickets, projets et équipes Linear.', mcpUrl: 'https://mcp.linear.app/mcp', oauth: chezLui('mcp.linear.app'), outils: {} },
  { cle: 'webflow', nom: 'Webflow', texte: 'Vos sites et contenus Webflow.', mcpUrl: 'https://mcp.webflow.com/mcp', oauth: chezLui('mcp.webflow.com'), outils: {} },
  { cle: 'sentry', nom: 'Sentry', texte: 'Erreurs et projets Sentry.', mcpUrl: 'https://mcp.sentry.dev/mcp', oauth: chezLui('mcp.sentry.dev'), outils: {} },
];

/** Fermé par défaut (parente, 25/11) : brancher et servir attendent la relecture et l'accord de Robert. Couper reste toujours possible. */
export const connecteursOuverts = (env: NodeJS.ProcessEnv = process.env): boolean => env.CONNECTEURS_OUVERTS === '1';

export const connecteur = (cle: unknown): Connecteur | null => CONNECTEURS.find((c) => c.cle === cle) ?? null;

/** Un outil relu, ou null. Jamais par la chaîne de prototypes (`constructor`, `toString`…). */
export const outilRelu = (c: Connecteur, nom: string): OutilRelu | null => (Object.hasOwn(c.outils, nom) ? c.outils[nom] : null);
/** Le service a au moins un outil qui écrit : seulement alors l'interrupteur a un sens. */
export const saitEcrire = (c: Connecteur): boolean => Object.values(c.outils).some((o) => o.acces === 'ecriture');
