# Connexions à des services extérieurs (VER-119, VER-244)

Une personne relie un service qu'elle utilise déjà ; son IA en retrouve les outils à côté de ses apps Veridian. Écran : `/dashboard/connexions`.
**FERMÉ** (`CONNECTEURS_OUVERTS` absent du job) : rien au menu, « brancher » refusé avant tout départ. Seuls les gestes qui RETIRENT un accès restent.
Ouvrir, et inscrire Veridian chez un tiers, sont des gestes de Robert. Aucune épreuve n'appelle un service réel.

- **Aucune application à créer** : chaque service du registre (`lib/connecteurs/registre.ts`) publie un serveur MCP protégé par OAuth et accepte qu'un
  client s'enregistre seul (RFC 7591). Coût nul. Pas d'enregistrement automatique : HubSpot, Asana. Canva enregistre puis refuse notre retour : retiré.
- **Tout est figé dans le registre** : adresse du service, hôtes d'autorisation, de jeton, d'enregistrement et de révocation, outils servis. N'y entre
  jamais un service qui déplace de l'argent.
- **Outils** (`outils.ts`) : servis seulement s'ils sont au registre, avec leur classe (lecture ou écriture, jugée par nous : `readOnlyHint` n'est pas une
  preuve) et l'empreinte de leur définition ENTIÈRE relue. Un mot change, l'outil disparaît et sa définition se relève dans `connecteur_outils_vus`.
  **Aujourd'hui aucun outil n'est relu : même relié, un service ne sert rien.** Écriture éteinte par défaut, allumée par la personne, service par service.
- **Texte d'un tiers** (`texte.ts`) : résultats et erreurs nettoyés, en texte seul, entre deux bornes tirées au hasard, avec leur origine ; les raisons
  d'échec sont nos mots. Le journal d'une organisation n'en dit rien.
- **Sortie** (`sortie.ts`) : hôte du registre, HTTPS, IP réellement jointe publique, aucune redirection, taille et durée TOTALE bornées.
- **Échange** (`oauth.ts`) : émetteur figé (RFC 8414), chaque adresse annoncée comparée avant usage, code, PKCE, `state`, jeton demandé pour CE service
  (RFC 8707). Transaction scellée dans le navigateur, 10 min, finie par la seule personne qui l'a ouverte, jamais par une session d'organisation ou d'emprunt.
  Seul `partir` inscrit notre client ; le jeton de gestion de l'inscription est gardé chiffré (RFC 7592).
- **Coffre** (`coffre.ts`) : jetons chiffrés (`VAULT_ENC_KEY`), jamais rendus ni journalisés. Chaque écriture compare ce qu'elle a lu : coupure,
  renouvellement et rebranchement peuvent se croiser. Un jeton neuf sans connexion est révoqué, jamais rendu.
  Rebrancher ne remplace rien : les deux comptes se montrent, la personne choisit, l'autre jeu est révoqué. « Coupé » se dit de chez eux seulement confirmé.
- **Porte MCP** (`porte.ts`) : `notion.<outil>`, avec le jeton de la personne, aucune identité du Hub. Visible d'une connexion IA dont le consentement
  l'a dit (`oauth_tokens.services`) : jamais celles d'avant, ni Mon IA, ni une session d'organisation ou d'emprunt. Compte sans espace vivant, ou dont un
  espace à lui est suspendu : rien. Jamais dans un programme.

- **Deux versions ensemble** (bascule) : le renouvellement tient un bail en base. Les versions d'avant le 26/11 remplacent en silence : ne jamais ouvrir
  l'interrupteur dans le déploiement qui pose ce code, seulement après.
- **Portée** : aucune n'est demandée (`portee`), le jeton peut porter plus que ce que nous servons ; à fixer en lecture à l'ouverture, service par service.

## Gestes

- **Relire les outils d'un service** (après la première vraie connexion) : `GET /api/admin/connecteurs` (`outils_a_relire`), lire chaque définition comme
  une donnée, classer, puis l'inscrire avec son empreinte dans le registre.
- **Effacer notre inscription** : `DELETE /api/admin/connecteurs` `{connecteur, retour, confirm: true}`. Les cinq du 25/11 n'ont pas de jeton de gestion
  gardé : `sans_jeton` (Notion, Linear, Webflow, Sentry) ; Canva n'est plus au registre.
- **Ajouter un service** : une entrée du registre, puis l'éprouver jusqu'à son écran de consentement (Robert).

Éprouvé : service jetable complet (`e2e/systeme-sso/lib/service-jetable.ts`), chaque garde retirée une à une (`lourd node scripts/sabotages-connecteurs.mjs`).
NON PROUVÉ : un consentement réel ; que les hôtes réels soient tous celui du serveur MCP (sinon refus) ; les noms de compte (`workspace_name`) rendus ;
qu'un service réponde en JSON ou ferme son flux.

## Relevé VER-114 (27/11/2026) : la liste d'Academy contre ce que le Hub sert

Mesure : métadonnées OAuth PUBLIQUES de chaque serveur MCP officiel (`/.well-known/oauth-authorization-server`, ou la ressource protégée puis son
serveur d'autorisation), lues sans rien inscrire ; contrôle positif : les quatre services du registre annoncent bien l'inscription automatique.
**Branché et éprouvé par une vraie connexion : aucun.** Registre : Notion, Linear, Webflow, Sentry, inscrits chez eux, FERMÉS, aucun outil relu.
Les quatre clients OAuth classiques créés le 07/11 (Cloudflare, Google, Microsoft, Supabase, `INTEG_*` au coffre) ne sont lus par aucun code du Hub.

| Groupe | Services | Ce qu'il faut |
|---|---|---|
| A. Sans rien créer chez eux : MCP officiel, inscription automatique annoncée | Atlassian, Vercel, Neon, Figma, Netlify, Cloudflare (observability), GitLab, Airtable, Make, Supabase, PostHog, Todoist, Calendly | Une entrée au registre (Hub), puis l'éprouver jusqu'à l'écran de consentement : le compte est celui de la PERSONNE, Veridian n'a pas à en avoir un. Ouvrir et relire les outils restent des gestes de Robert. Annoncée ≠ acceptée (Canva enregistrait puis refusait notre retour) |
| B. Une application chez le fournisseur (geste de Robert) | HubSpot, Asana (pas d'inscription automatique), GitHub (pas de métadonnées OAuth du MCP : GitHub App sur `Veridian-site`, validation mobile), Pipedrive (aucune ressource protégée annoncée) ; Google, Microsoft (clients classiques déjà créés : il manque un connecteur OAuth classique au Hub, et la vérification des portées chez Google) | |
| C. Impossible | Stripe (annonce l'inscription, mais déplace de l'argent : jamais au registre) ; Canva (retiré, retour refusé) | |

Neon n'est plus « impossible » : son MCP accepte l'inscription automatique, sans programme partenaires.
