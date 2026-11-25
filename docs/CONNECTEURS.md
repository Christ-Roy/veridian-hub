# Connexions à des services extérieurs (VER-119, VER-244)

Une personne relie un service qu'elle utilise déjà ; son IA en retrouve les outils à côté de ses apps Veridian. Écran : `/dashboard/connexions`.

- **Aucune application à créer** : chaque service du registre (`lib/connecteurs/registre.ts`) publie un serveur MCP protégé par OAuth et accepte qu'un
  client s'enregistre seul (RFC 7591). Mesuré le 25/11 : Notion, Linear, Canva, Webflow, Sentry, Atlassian, Intercom, Pennylane, Vercel, Stripe, PayPal,
  Cloudflare. Coût nul. Pas d'enregistrement automatique : HubSpot, Asana. **Vus jusqu'à leur écran, en prod (cas 43)** :
  Notion, Linear, Webflow, Sentry. Canva enregistre puis refuse notre adresse de retour (« Invalid redirect URI ») : retiré.
- **Registre figé dans le code** : l'adresse n'est jamais reçue. N'y entre jamais un service qui déplace de l'argent.
- **Échange** (`oauth.ts`) : découverte (RFC 9728, 8414), code, PKCE, `state`, jeton demandé pour CE service (`resource`, RFC 8707). Transaction scellée dans
  le navigateur, 10 min, finie par la seule personne qui l'a ouverte. Sortie : IP réellement jointe publique, HTTPS, sans redirection.
- **Coffre** (`coffre.ts`) : jetons chiffrés au repos (`VAULT_ENC_KEY`), jamais rendus ni journalisés. Renouvellement unique ; refusé par le service : « à
  rebrancher » ; service en panne : on ne conclut rien. Une connexion est à la PERSONNE, jamais à l'organisation. Compte supprimé : toutes coupées.
- **Porte MCP** (`porte.ts`) : `notion.<outil>`, `linear.<outil>`. Le jeton de la personne, aucune identité signée du Hub. Jamais depuis un programme.
- **Ajouter un service** : une ligne dans le registre, puis l'éprouver jusqu'à son écran de consentement.

Éprouvé : service jetable complet (`e2e/systeme-sso/lib/service-jetable.ts`). NON PROUVÉ : un consentement réel, par une vraie personne.
