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
  /**
   * Client créé chez le service, à la main (Google, 27/11 : pas d'inscription automatique) : les NOMS des variables qui portent son identifiant et son secret.
   * Jamais d'inscription d'ici, jamais d'effacement chez lui. Variables absentes : le service n'est pas branchable.
   */
  preinscrit?: { id: string; secret: string };
  /** Paramètres de départ propres au service, figés (Google : `access_type=offline` pour un jeton de renouvellement). */
  depart?: Readonly<Record<string, string>>;
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

/** Google : autorisation chez accounts.google.com, jeton et révocation chez oauth2.googleapis.com, aucune inscription (lu le 27/11). */
const GOOGLE: HotesOAuth = { emetteur: 'https://accounts.google.com', autorisation: 'accounts.google.com', jeton: 'oauth2.googleapis.com', enregistrement: '', revocation: 'oauth2.googleapis.com' };
const CLIENT_GOOGLE = { id: 'INTEG_GOOGLE_CLIENT_ID', secret: 'INTEG_GOOGLE_CLIENT_SECRET' } as const;
/** Sans `access_type=offline`, Google ne rend pas de jeton de renouvellement ; `prompt=consent` le redemande à chaque branchement. */
const DEPART_GOOGLE = { access_type: 'offline', prompt: 'consent' } as const;

/**
 * Candidats (VER-114, 27/11/2026) : serveur MCP officiel dont les métadonnées PUBLIQUES annoncent l'inscription automatique (RFC 7591), adresses figées
 * d'après elles, lues sans rien inscrire. JAMAIS servis : `connecteur()` ne les connaît pas. Un candidat entre dans CONNECTEURS quand l'inscription de
 * Veridian chez lui (geste de Robert) a été acceptée et relue, et que son écran de consentement a été VU. Annoncée n'est pas acceptée (Canva).
 */
export const CANDIDATS: readonly Connecteur[] = [
  { cle: 'atlassian', nom: 'Atlassian', texte: 'Tickets Jira et pages Confluence.', mcpUrl: 'https://mcp.atlassian.com/v1/mcp', oauth: { emetteur: 'https://mcp.atlassian.com', autorisation: 'mcp.atlassian.com', jeton: 'mcp.atlassian.com', enregistrement: 'mcp.atlassian.com', revocation: 'mcp.atlassian.com' }, outils: {} },
  { cle: 'vercel', nom: 'Vercel', texte: 'Projets et déploiements Vercel.', mcpUrl: 'https://mcp.vercel.com/', oauth: { emetteur: 'https://vercel.com', autorisation: 'vercel.com', jeton: 'api.vercel.com', enregistrement: 'api.vercel.com', revocation: 'api.vercel.com' }, outils: {} },
  { cle: 'neon', nom: 'Neon', texte: 'Bases Postgres Neon.', mcpUrl: 'https://mcp.neon.tech/mcp', oauth: { emetteur: 'https://mcp.neon.tech', autorisation: 'mcp.neon.tech', jeton: 'mcp.neon.tech', enregistrement: 'mcp.neon.tech', revocation: 'mcp.neon.tech' }, outils: {} },
  { cle: 'figma', nom: 'Figma', texte: 'Fichiers et maquettes Figma.', mcpUrl: 'https://mcp.figma.com/mcp', oauth: { emetteur: 'https://api.figma.com', autorisation: 'www.figma.com', jeton: 'api.figma.com', enregistrement: 'api.figma.com', revocation: '' }, outils: {} },
  { cle: 'netlify', nom: 'Netlify', texte: 'Sites et déploiements Netlify.', mcpUrl: 'https://mcp.netlify.com/mcp', oauth: { emetteur: 'https://mcp.netlify.com/', autorisation: 'mcp.netlify.com', jeton: 'mcp.netlify.com', enregistrement: 'mcp.netlify.com', revocation: '' }, outils: {} },
  { cle: 'cloudflare', nom: 'Cloudflare', texte: 'Journaux et observabilité Cloudflare.', mcpUrl: 'https://observability.mcp.cloudflare.com/mcp', oauth: { emetteur: 'https://observability.mcp.cloudflare.com', autorisation: 'observability.mcp.cloudflare.com', jeton: 'observability.mcp.cloudflare.com', enregistrement: 'observability.mcp.cloudflare.com', revocation: 'observability.mcp.cloudflare.com' }, outils: {} },
  { cle: 'gitlab', nom: 'GitLab', texte: 'Projets, tickets et demandes de fusion GitLab.', mcpUrl: 'https://gitlab.com/api/v4/mcp', oauth: { emetteur: 'https://gitlab.com', autorisation: 'gitlab.com', jeton: 'gitlab.com', enregistrement: 'gitlab.com', revocation: 'gitlab.com' }, outils: {} },
  { cle: 'airtable', nom: 'Airtable', texte: 'Bases et tables Airtable.', mcpUrl: 'https://mcp.airtable.com', oauth: { emetteur: 'https://airtable.com/oauth2/v1', autorisation: 'airtable.com', jeton: 'airtable.com', enregistrement: 'airtable.com', revocation: '' }, outils: {} },
  { cle: 'make', nom: 'Make', texte: 'Scénarios Make.', mcpUrl: 'https://mcp.make.com', oauth: { emetteur: 'https://www.make.com/mcp', autorisation: 'www.make.com', jeton: 'www.make.com', enregistrement: 'www.make.com', revocation: 'www.make.com' }, outils: {} },
  { cle: 'supabase', nom: 'Supabase', texte: 'Projets et bases Supabase.', mcpUrl: 'https://mcp.supabase.com/mcp', oauth: { emetteur: 'https://api.supabase.com', autorisation: 'api.supabase.com', jeton: 'api.supabase.com', enregistrement: 'api.supabase.com', revocation: '' }, outils: {} },
  { cle: 'posthog', nom: 'PostHog', texte: 'Analyses de produit PostHog.', mcpUrl: 'https://mcp.posthog.com/mcp', oauth: { emetteur: 'https://oauth.posthog.com', autorisation: 'oauth.posthog.com', jeton: 'oauth.posthog.com', enregistrement: 'oauth.posthog.com', revocation: 'oauth.posthog.com' }, outils: {} },
  { cle: 'todoist', nom: 'Todoist', texte: 'Tâches et projets Todoist.', mcpUrl: 'https://ai.todoist.net/mcp', oauth: { emetteur: 'https://todoist.com', autorisation: 'todoist.com', jeton: 'todoist.com', enregistrement: 'todoist.com', revocation: 'todoist.com' }, outils: {} },
  { cle: 'calendly', nom: 'Calendly', texte: 'Rendez-vous et disponibilités Calendly.', mcpUrl: 'https://mcp.calendly.com/', oauth: { emetteur: 'https://calendly.com/', autorisation: 'calendly.com', jeton: 'calendly.com', enregistrement: 'calendly.com', revocation: '' }, outils: {} },
  // Google (27/11) : MCP officiels, client « Veridian Integrations » créé dans la console (projet veridian-preprod), pas d'inscription automatique.
  // Portées sans évaluation payante seulement : drive.file (non sensible) ; calendar.events.readonly (sensible : vérification gratuite, ou mode Test).
  // Gmail en lecture n'existe qu'en portée RESTREINTE (évaluation de sécurité payante) : absent, c'est une dépense à décider par Robert.
  { cle: 'gdrive', nom: 'Google Drive', texte: 'Les fichiers Drive que vous ouvrez avec Veridian.', mcpUrl: 'https://drivemcp.googleapis.com/mcp/v1', oauth: GOOGLE, outils: {}, portee: 'https://www.googleapis.com/auth/drive.file', preinscrit: CLIENT_GOOGLE, depart: DEPART_GOOGLE },
  { cle: 'gagenda', nom: 'Google Agenda', texte: 'Les événements de votre agenda Google, en lecture.', mcpUrl: 'https://calendarmcp.googleapis.com/mcp/v1', oauth: GOOGLE, outils: {}, portee: 'https://www.googleapis.com/auth/calendar.events.readonly', preinscrit: CLIENT_GOOGLE, depart: DEPART_GOOGLE },
];

/**
 * Fermé par défaut (parente, 25/11) : brancher et servir attendent la relecture et l'accord de Robert. Couper reste toujours possible.
 * `1` : ouvert à tous. `@<hub_user_id>[,@…]` : ouvert à ces personnes seulement (27/11 : d'abord Robert, le temps de relire les outils de chaque
 * service avec ses comptes ; une connexion appartient à une personne, jamais à une organisation). Personne inconnue : fermé.
 */
export const connecteursOuverts = (qui?: string | null, env: NodeJS.ProcessEnv = process.env): boolean => {
  const v = (env.CONNECTEURS_OUVERTS ?? '').trim();
  if (v === '1') return true;
  if (!qui) return false;
  return v.split(',').map((x) => x.trim()).some((x) => x.startsWith('@') && x.slice(1) === qui);
};

export const connecteur = (cle: unknown): Connecteur | null => CONNECTEURS.find((c) => c.cle === cle) ?? null;

/** Un outil relu, ou null. Jamais par la chaîne de prototypes (`constructor`, `toString`…). */
export const outilRelu = (c: Connecteur, nom: string): OutilRelu | null => (Object.hasOwn(c.outils, nom) ? c.outils[nom] : null);
/** Le service a au moins un outil qui écrit : seulement alors l'interrupteur a un sens. */
export const saitEcrire = (c: Connecteur): boolean => Object.values(c.outils).some((o) => o.acces === 'ecriture');
