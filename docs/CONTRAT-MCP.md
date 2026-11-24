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
- Trois outils exposés, pour ne pas payer le catalogue à chaque tour, et un quatrième quand le moteur des programmes
  est configuré (`executer_programme`, section « Mode programme ») :
  `chercher_outils(besoin, app?)` → noms + une ligne ; `decrire_outil(nom)` → schéma ;
  `executer_outil(nom, arguments)`. Les noms sont `<app>.<outil>`. L'app `hub` porte les outils du Hub.
- Sorties plafonnées (~16 000 caractères) : au-delà, tronquées avec un avis ; les apps paginent.
- Boutons « Ajouter à … » : `GET https://app.veridian.site/api/mcp/liens-installation[?app=<cle>]`, public, sans
  donnée personnelle, CORS ouvert, cache 5 min. Rend `url` (adresse MCP), `assistants` (`[{ cle, libelle,
  installation, etape }]` pour claude, chatgpt, cursor, vscode ; `etape` non nulle seulement quand le lien ne
  préremplit pas, ChatGPT), `claudeCode` (commande), et les champs plats `claude`, `chatgpt`, `cursor`, `vscode`,
  `instructions.chatgpt`. `app=<cle du registre>` ajoute `app: { cle, nom, phrase }` pour que l'app se mette en
  avant ; clé inconnue ou coupée : `app: null`. Le connecteur reste « Veridian », un seul pour toutes les apps.
  Chaque app affiche les boutons chez elle à partir de cette réponse, sans recopier les liens. Révocation :
  `/dashboard/ia` au Hub.
  Origines garanties des liens `installation` : `https://claude.ai`, `https://chatgpt.com`, schéma `cursor:`,
  `https://vscode.dev`. Une app peut retirer un bouton hors de ces origines (Twenty le fait, avec un warn). Le
  chemin peut changer sans préavis ; une nouvelle origine s'annonce aux apps avant d'être servie.

## Côté app (ce que chaque app implémente)

1. Un endpoint MCP Streamable HTTP (JSON ou SSE), `tools/list` et `tools/call`.
2. Chaque requête du Hub porte `Authorization: Bearer <JWT>` :
   - `alg` ES256, `kid` publié dans `https://app.veridian.site/.well-known/jwks.json` (cache ≤ 1 h) ;
   - `iss` = `https://app.veridian.site`, `aud` = l'URL MCP de l'app telle qu'inscrite au registre ;
   - `sub` = `hub_user_id` (jamais `users.id`), `email`, `email_verified: true`, `scope`, `exp` = 5 min ;
   - `client_id` : le client IA d'origine (journal), `client_name` : son nom déclaré (« Claude »,
     « ChatGPT »…), `jti` unique ;
   - `tenant_id` (facultatif) : l'espace Hub où agir, présent seulement si l'IA l'a choisi
     (`espace=<slug>` de `executer_outil`) et que la porte a vérifié que l'utilisateur en est
     propriétaire ou membre. Jamais d'office. Absent : l'app choisit l'espace par défaut de
     l'utilisateur. L'app revérifie l'appartenance et sait relier un id de tenant Hub à son espace.
   L'app vérifie signature, `iss`, `aud`, `exp`, puis retrouve l'utilisateur par `hub_user_id`.
   Inconnu : HTTP 401 avec `hub_user_unknown` dans le corps, jamais de création côté app. Le Hub crée
   alors le compte par son chemin habituel (`lib/mcp/provisionneurs.ts` : Twenty par
   `ensureCrmWorkspace`), oublie l'échec et réessaie une fois. Une app sans provisionneur au Hub crée
   ses comptes à la première ouverture depuis l'espace Veridian.
3. L'espace (tenant) vient du `tenant_id` signé ou, à défaut, de l'utilisateur : jamais d'un argument
   d'outil fourni par l'IA (`espace` est un paramètre de la porte, jamais transmis à l'app).
   Règle commune à toutes les apps (tranchée le 09/11) :

   | `tenant_id` | Réponse de l'app |
   |---|---|
   | absent | espace par défaut de l'utilisateur |
   | relié à un espace dont l'utilisateur est membre | cet espace |
   | relié à aucun espace de l'app | 403, `error: tenant_not_linked` |
   | relié, utilisateur non membre | 403, `error: tenant_forbidden` |

   Jamais de repli silencieux sur l'espace par défaut, jamais de 401 pour ces cas : le 401 est réservé
   au jeton (`hub_user_unknown`, jeton invalide). Le code d'erreur figure dans le corps (JSON-RPC
   `error.data.error` ou `error.message`). Chaque app relie l'id de tenant Hub à son espace
   (Prospection : `hub_tenant_id` au provisionnement et `link-hub` ; Notifuse : `hub_tenant_id` à
   l'update-plan).
4. `tools/list` ne rend que ce que cet utilisateur peut faire ; descriptions d'une ligne, `annotations`
   (`readOnlyHint`, `destructiveHint`) renseignées : le Hub les relaie au client.
5. Réponses bornées et paginées (curseur), JSON compact.

## Mode programme (`executer_programme`, 24/11)

Pour traiter des milliers de lignes sans que l'IA les lise : `executer_programme({ code, espace?, autoriser?, reprise? })`.
`code` est le corps d'une fonction async JavaScript ; il appelle les outils en boucle et seule la valeur de son `return`
revient (16 000 caractères).

| Dans le code | Rôle |
|---|---|
| `await outil("<app>.<outil>", {…})` | la donnée de l'outil (`structuredContent`, sinon son JSON, sinon son texte) ; une erreur d'outil est une exception |
| `sauver(etat)` | garde où on en est (JSON, 2 000 caractères), rendu sous `reprise` |
| `reprise` | la valeur passée en paramètre, `null` sinon |
| `journal(…)`, `await pause(ms)` | trace courte, attente |

**Signatures** (`lib/mcp/signature.ts`) : `decrire_outil` rend, en plus du schéma, `signature` (TypeScript compact tiré de l'`inputSchema`, 1 500 caractères au plus, `unknown` si le schéma est illisible, texte du schéma neutralisé), avec « // à nommer dans autoriser » si `exigeAutorisation` ; `chercher_outils` la porte pour ses 3 premiers résultats.

**Bornes** : 45 s (catalogue compris), 200 appels, 4 de front, 64 Mo, 1 Mo par réponse d'outil, 100 000 caractères de
code, un programme à la fois par utilisateur, 600 appels internes par minute (vérifiés avant de lancer, jamais à
mi-course). Ces deux derniers comptes vivent en mémoire du Hub : une seule allocation sert la porte, deux pendant les 60 s
d'un déploiement (au plus deux programmes par utilisateur à ce moment ; le moteur, lui, est unique et tient 4 places).
Le limiteur de la porte compte un programme pour un appel. Un 429 d'app est attendu (`Retry-After`) et refait.

**Réponse**, toujours un état : `termine`, `interrompu` (échéance : `reprise`, `appels`, et les appels d'`issue_inconnue`,
peut-être joués par l'app), `erreur`, `non_lance` (moteur plein ou muet). Reprendre : relancer le même code avec
`reprise`.

**Droits** : chaque appel passe par le même chemin qu'`executer_outil` (identité, espace choisi à l'ouverture et signé,
apps ouvertes au compte). Tout outil qui ne déclare pas `readOnlyHint: true`
(ou qui se dit aussi destructif) est refusé s'il n'est pas nommé dans `autoriser` : une écriture se nomme, toujours.
Un outil qui administre (membres, rôles, clés,
webhooks, apps, réglages : `lib/mcp/reserves.ts`, par motif) est refusé dans un programme, MÊME nommé ; il reste possible en appel direct, sauf,
chez Analytics, ce qui change un utilisateur ou son appartenance : au Hub seul. Un outil annoté lecture dont le nom porte un verbe d'écriture (`create`, `import`, `delete`…) se nomme aussi. Un programme n'appelle aucun outil de
la porte. Journal : `mcp.tool.call` par appel avec l'identifiant du programme, `mcp.programme` (empreinte du code, noms
autorisés, comptes) ; jamais le code ni les arguments. Mon IA n'offre pas cet outil.

**Clients à l'ancienne liste** : un client garde `tools/list` en cache et la porte sans état ne peut pas l'avertir. Le même outil
existe donc sous `hub.executer_programme`, trouvé par `chercher_outils`, décrit par `decrire_outil`, joué par `executer_outil`
(mêmes bornes, même `autoriser`, même journal). Fermé par défaut : seule la porte publique (`app/api/mcp`) l'offre, Mon IA ne
l'atteint par aucun des deux noms, un programme non plus.

**Côté app** : l'en-tête `X-Veridian-MCP-Appel: programme` accompagne ces appels. Il autorise une app à rendre une page plus
grosse (1 Mo au plus) ; il ne donne **aucun droit**. Une app qui coupe ses réponses doit le lire
et rendre la page entière, ou une erreur franche au-delà de 1 Mo : **jamais un JSON coupé**. Le Hub rend un JSON illisible en
erreur explicite (« l'app a coupé sa réponse »), jamais en texte. Une app qui ne coupe pas n'a rien à changer. Le Hub ouvre
une seule session MCP par app et par programme.

**Enfermement** : le code vient d'un modèle, donc rien n'est à prendre s'il sort de QuickJS. Il tourne dans le groupe Nomad
`programme`, hors du Hub : conteneur sans réseau ni secret, un processus neuf par programme, en chroot dans une prison en
lecture seule (`node`, QuickJS, rien d'autre), sous un uid réservé, tué à la fin. La passerelle (seule pièce avec un réseau,
aucun secret) vérifie la signature ES256 du Hub et transporte. Le Hub ne croit rien de ce qui revient (noms, tailles,
nombre, durée, droits). Preuve sur ce qui est servi : `scripts/epreuve-programme.sh` (exécuteur compromis, témoin dans le
Hub) et le cas 18 de la batterie.

## Accès

Une app inscrite est proposée à un utilisateur si `mcp_apps.acces = 'tous'`, ou si `acces = 'tenant_app'`
et une ligne `tenant_apps` active existe pour lui (`app_key` = clé du registre). Chaque `executer_outil`
écrit `audit_log` (`mcp.tool.call` : client, outil, issue, durée ; jamais les arguments), appel d'un programme compris.

## Preuve

`__tests__/lib/mcp/` (OAuth, PKCE, rotation, révocation, porte, fédération sur une app factice) ;
en prod, un vrai client MCP passe le parcours complet (enregistrement, consentement, appel).

## Connexions d'un compte, lues par une app

`GET https://app.veridian.site/api/hub/connexions-ia?hub_user_id=<uuid>`, signé HMAC §6.1 sur
`${timestamp}.` avec le secret Hub de l'app (`X-Veridian-Timestamp`, `X-Veridian-Hub-Signature`).
Réponse : `{ hub_user_id, connexions: [{ client, depuis, derniere_utilisation }] }`. Permet d'afficher
« Claude connecté » avant le premier appel d'outil. Page utilisateur : `/dashboard/ia` (adresse stable).
