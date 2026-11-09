# Contrat MCP Veridian (09/11/2026)

Une IA (Claude, ChatGPT, Codex, Cursor) se branche **une seule fois**, sur le Hub, et atteint toutes
les apps. Le Hub ne sait rien des apps au-delà de leur adresse : il est registre d'identité et porte.

## Les rôles

| Qui | Fait | Ne fait jamais |
|---|---|---|
| Hub | serveur OAuth 2.1 des clients IA ; porte MCP `https://app.veridian.site/api/mcp` ; registre des apps (`mcp_apps`) ; signe l'identité | coder un outil d'app, stocker une clé d'app pour l'IA |
| App | sert son MCP (Streamable HTTP) ; vérifie le jeton du Hub ; filtre ses outils selon les droits de l'utilisateur | émettre des comptes, demander une clé au client |

Modifier les outils d'une app ne touche pas le Hub : il relit `tools/list` de l'app (cache 5 min par
utilisateur ; un échec est gardé 30 s par utilisateur et oublié dès qu'un compte d'app est créé).
Ajouter une app : une ligne au registre (`hub mcp-app add <cle> <url_mcp>`), aucun déploiement du Hub.

## Côté client IA

- Adresse : `https://app.veridian.site/api/mcp`. Sans jeton : `401` et
  `WWW-Authenticate: Bearer resource_metadata="https://app.veridian.site/.well-known/oauth-protected-resource"`.
- Découverte : RFC 9728 (ressource protégée), RFC 8414 (`/.well-known/oauth-authorization-server`),
  enregistrement dynamique RFC 7591 (clients publics), code + PKCE S256 obligatoire, `resource` RFC 8707.
- Jeton d'accès opaque 1 h, jeton de renouvellement 30 j à rotation (réutilisation = famille révoquée).
  En base : empreintes SHA-256 seulement. « Se déconnecter partout » coupe aussi les IA
  (`users.sessions_valid_after`). Révocation unitaire : Réglages > Sécurité.
- Seulement 3 outils exposés, pour ne pas payer le catalogue à chaque tour :
  `chercher_outils(besoin, app?)` → noms + une ligne ; `decrire_outil(nom)` → schéma ;
  `executer_outil(nom, arguments)`. Les noms sont `<app>.<outil>`. L'app `hub` porte les outils du Hub.
- Sorties plafonnées (~16 000 caractères) : au-delà, tronquées avec un avis ; les apps paginent.

## Côté app (ce que chaque app implémente)

1. Un endpoint MCP Streamable HTTP (JSON ou SSE), `tools/list` et `tools/call`.
2. Chaque requête du Hub porte `Authorization: Bearer <JWT>` :
   - `alg` ES256, `kid` publié dans `https://app.veridian.site/.well-known/jwks.json` (cache ≤ 1 h) ;
   - `iss` = `https://app.veridian.site`, `aud` = l'URL MCP de l'app telle qu'inscrite au registre ;
   - `sub` = `hub_user_id` (jamais `users.id`), `email`, `email_verified: true`, `scope`, `exp` = 5 min ;
   - `client_id` : le client IA d'origine (journal), `jti` unique ;
   - `tenant_id` (facultatif) : l'espace Hub où agir, présent seulement si la porte a vérifié que
     l'utilisateur en est propriétaire ou membre (`espace=<slug>` de `executer_outil`, ou son espace
     unique). Absent : l'app choisit l'espace par défaut de l'utilisateur. L'app revérifie l'appartenance.
   L'app vérifie signature, `iss`, `aud`, `exp`, puis retrouve l'utilisateur par `hub_user_id`.
   Inconnu : HTTP 401 avec `hub_user_unknown` dans le corps, jamais de création côté app. Le Hub crée
   alors le compte par son chemin habituel (`lib/mcp/provisionneurs.ts` : Twenty par
   `ensureCrmWorkspace`), oublie l'échec et réessaie une fois. Une app sans provisionneur au Hub crée
   ses comptes à la première ouverture depuis l'espace Veridian.
3. L'espace (tenant) vient du `tenant_id` signé ou, à défaut, de l'utilisateur : jamais d'un argument
   d'outil fourni par l'IA (`espace` est un paramètre de la porte, jamais transmis à l'app).
4. `tools/list` ne rend que ce que cet utilisateur peut faire ; descriptions d'une ligne, `annotations`
   (`readOnlyHint`, `destructiveHint`) renseignées : le Hub les relaie au client.
5. Réponses bornées et paginées (curseur), JSON compact.

## Accès

Une app inscrite est proposée à un utilisateur si `mcp_apps.acces = 'tous'`, ou si `acces = 'tenant_app'`
et une ligne `tenant_apps` active existe pour lui (`app_key` = clé du registre). Chaque `executer_outil`
écrit `audit_log` (`mcp.tool.call` : client, outil, issue, durée ; jamais les arguments).

## Preuve

`__tests__/lib/mcp/` (OAuth, PKCE, rotation, révocation, porte, fédération sur une app factice) ;
en prod, un vrai client MCP passe le parcours complet (enregistrement, consentement, appel).
