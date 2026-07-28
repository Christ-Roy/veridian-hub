# [HUB ↔ ANALYTICS-ENGINE] Autologin : état réel sondé + contrat à implémenter côté engine

> **Sévérité** : 🟠 P1 (bloque la livraison d'un client Analytics ; pas de régression, ça n'a jamais marché)
> **Créé** : 2026-07-28 par agent hub (suite du chantier autologin cross-app)
> **Remplace/précise** : `todo/2026-06-22-brancher-analytics-au-broker-sso-autologin.md`
> **Destinataire principal** : agent `analytics-sso-engine` (§3 est son cahier des charges)
> **Repo engine** : `/home/brunon5/Bureau/veridian-platform/veridian-analytics`
> (`api/`, `console/`, `veridian-bridge/`, `deploy/analytics-engine*.nomad.hcl`)
> **Statut** : aucun code Hub écrit contre ces routes tant qu'elles répondent 404 — voir §2.

---

## TL;DR

1. **La route SSO n'existe pas côté engine.** Le ticket de juin supposait qu'elle
   existait « ou allait exister » : c'est la seconde branche. Sondé en live, prod
   et staging : 404 sur tous les chemins candidats.
2. **Plus large que prévu** : l'engine n'expose **aucun** des endpoints obligatoires
   du contrat Hub (§5 de `CONTRAT-HUB.md`). Il n'a que sa surface native staminads
   `/api/admin/platform/*`.
3. **Le client Analytics du Hub est cassé indépendamment de l'autologin** :
   `lib/analytics/client.ts` appelle les chemins de l'app **legacy morte**, et sa
   variable d'environnement `ANALYTICS_ADMIN_KEY` **n'est déployée nulle part**.
   La page `/dashboard/admin/analytics` ne peut donc rien faire aujourd'hui.
4. ~~La clé M2M staging est rejetée (401)~~ — **résolu** par `analytics-sso-engine` :
   la clé staging a divergé de la prod depuis le passage à Nomad et vit dans la
   Nomad var `nomad/jobs/analytics-engine-staging` → `PLATFORM_ADMIN_API_KEY`.
   Le mapping en dur du CLI (`~/bin/analytics`, `KEY_VARS`) datait de l'ère Dokploy.
5. **Le mécanisme livré pour Notifuse n'est pas transposable** — raison en §2.
6. **`workspace_id` n'est connu du Hub que dans un cas sur trois** — c'est ce qui
   décide du scope du jeton côté engine. Détail et proposition en §3.3bis.

---

## 1. Ce qui a été sondé, et le résultat

Méthode : appels réels avec la vraie clé M2M plateforme
(`ANALYTICS_ENGINE_PLATFORM_ADMIN_KEY`, celle que le CLI `analytics` utilise),
body vide — donc **aucune écriture**. Un `400` prouve que la route existe (la
validation du DTO s'exécute) ; un `404` qu'elle n'est pas montée. NestJS route
avant d'authentifier, la distinction est donc fiable.

```
PROD — analytics-engine.app.veridian.site
  400  POST /api/admin/platform/tenants.provision        <- existe (surface native)
  404  POST /api/admin/platform/sso.issueToken
  404  POST /api/admin/platform/users.impersonate
  404  POST /api/admin/platform/users.magicLink
  404  POST /api/admin/platform/tenants.autologin
  404  POST /api/sso/issue-token          <- chemin annoncé par le ticket de juin
  404  POST /api/auth/token               <- chemin de consommation annoncé
  404  POST /api/sso/issue-magic-link     <- chemin du CONTRAT-HUB §6bis.8.3
  404  POST /api/tenants/provision        <- contrat §5, endpoint n°1 « obligatoire »
  404  POST /api/workspaces.generateMagicLink  <- contrat §5, endpoint n°7
  404  GET  /api/admin/tenants            <- surface LEGACY appelée par le Hub

STAGING — analytics-engine.staging.veridian.site
  401  POST /api/admin/platform/tenants.provision   <- clé M2M REJETÉE (cf. §4)
  404  … tous les mêmes chemins SSO
```

**Conclusion** : Analytics Engine ne parle pas le protocole Hub. Ce n'est pas
« la couche 1 SSO qui manque », c'est l'intégration entière qui n'a jamais été
faite — l'engine a été branché comme un outil autonome piloté par le CLI
`analytics`, jamais comme une app downstream du Hub.

---

## 2. Pourquoi aucun code Hub n'a été écrit, et pourquoi le resolver Notifuse ne sert pas

Écrire côté Hub une fonction qui appelle une route 404 produirait du code
non testable et un faux sentiment d'avancement. Le chemin critique est côté engine.

**Le mécanisme livré pour Notifuse le 2026-07-28** (`lib/notifuse/resolve-autologin.ts`)
repose sur une propriété précise du contrat Notifuse : `provisionWorkspace` est
idempotent et **renvoie un `auto_login_url` valide sur un workspace déjà existant**,
même sans clé API. C'est ce qui permet la cascade « clé API → sinon réparation ».

L'équivalent Analytics (`tenants.provision`) renvoie un **`password_reset_url`** :
d'après le contrat documenté, *« l'owner pose son mot de passe avant de pouvoir se
loguer »*. C'est un reset de mot de passe à usage unique, pas une session déléguée.
Il n'existe donc **aucun second chemin** sur lequel retomber : sans route SSO, il n'y
a rien à résoudre, et une cascade à un seul chemin mort n'est pas une cascade.

Ce qui reste réutilisable de ce travail : le **patron d'appel** (client HMAC
timing-safe, garde-fous d'entrée, échecs typés avec status HTTP propagé, backfill
best-effort non bloquant). Il sera repris tel quel le jour où l'engine expose la
route. Le mécanisme lui-même, non.

---

## 3. Cahier des charges côté `veridian-analytics-engine`

Le contrat est **déjà écrit et normatif** dans `docs/CONTRAT-HUB.md` §6bis.8.3 —
il n'y a rien à inventer, juste à l'implémenter. Reproduit ici pour éviter tout
aller-retour.

### 3.1 Route à exposer

```
POST /api/sso/issue-magic-link
Headers : X-Veridian-Timestamp: <unix_ms>
          X-Veridian-Hub-Signature: <hex(hmac_sha256(secret, "{timestamp}.{raw_body}"))>
          Content-Type: application/json
Body    : { "hub_user_id": "<uuid v4>", "email": "<string>",
            "workspace_id": "<string>"   // OPTIONNEL — cf. §3.3bis
          }
```

**Réponse 200** :
```json
{ "magic_link_url": "https://analytics-engine.app.veridian.site/auth/token?t=<token>" }
```

**Réponse 400** — l'user a un compte Hub mais aucun workspace dans l'app :
```json
{ "error": "user_not_in_app", "hint": "no workspace for this hub_user_id" }
```

**Réponse 409** — `workspace_id` absent du body et l'engine refuse d'émettre un
jeton non scopé (cf. §3.3bis) :
```json
{ "error": "workspace_required", "workspaces": [{ "id": "...", "name": "..." }] }
```

**Réponse 403** — `workspace_id` fourni mais l'user n'y a pas accès :
```json
{ "error": "workspace_mismatch" }
```

**Réponse 5xx** — app HS ; le Hub affiche une page d'erreur.

**Consommation du jeton — attention, la console n'est PAS en cookie.**
L'authentification de la console Analytics repose sur **localStorage**, pas sur un
cookie de session : une route qui se contenterait d'un `Set-Cookie` + 302 ne
connecterait personne. Il faut une page qui reçoit le jeton, écrit la session en
localStorage, puis redirige — exactement le pattern
`/veridian/auto-login?token=` de Notifuse (self-contained, TTL 60 s).
La forme exacte et l'URL finale sont à la main de l'agent engine : le Hub se cale
dessus, il ne fait que rediriger l'utilisateur vers l'URL rendue.

### 3.2 Vérification HMAC — **déjà implémentée, rien à écrire**

La couche HMAC **existe et tourne en prod** côté Analytics :
`veridian-bridge/src/hub-hmac.ts` (comparaison en temps constant, fenêtre
anti-rejeu de 5 min, signature sur le corps brut, refus de démarrer si le
contournement est activé hors développement, tests dédiés dans
`veridian-bridge/tests/hub/`). Trois routes l'utilisent déjà.

**La nouvelle route se branche dessus telle quelle.** Il n'y a pas de mécanisme
à spécifier, et surtout pas un second dialecte à introduire. Le format, pour
mémoire, est identique à celui de Notifuse/Prospection (contrat §6.1) :

1. `|now - timestamp| > 5 min` → rejet (timestamp en **millisecondes**).
2. `hmac_sha256(secret, timestamp + "." + raw_body)` sur le **corps brut**,
   jamais sur le JSON re-sérialisé.
3. Comparaison en **temps constant**.

**Nom du secret — deux noms légitimes, une seule valeur.** Aucun renommage à faire
de part ni d'autre :

| Côté | Variable | Où |
|---|---|---|
| Hub | `ANALYTICS_HUB_API_SECRET` (+ `_STAGING`) | `jobs/saas-prod/hub.nomad.hcl:148`, `hub-staging.nomad.hcl:183` |
| Engine / bridge | `HUB_HMAC_SECRET` | jobs Nomad engine, lu par `veridian-bridge/src/index.ts` |

Égalité des valeurs vérifiée sur staging par l'agent `analytics-sso-engine`
(Nomad var `HUB_HMAC_SECRET` == `ANALYTICS_HUB_API_SECRET_STAGING`).

> **Correction 2026-07-28** : une version antérieure de ce ticket affirmait que
> `HUB_HMAC_SECRET` était une erreur du ticket de juin et qu'il fallait
> s'aligner sur le nom Hub. C'est **faux** — les deux noms coexistent
> légitimement. Ne demandez aucun renommage.

### 3.3 Sémantique imposée

- La route **ne crée jamais** de workspace. Pas d'auto-provisioning silencieux
  (règle §6bis.2 « Pas d'auto-création »). Un user sans workspace → 400.
- Token **TTL court (≈15 min) et usage unique**. C'est un lien de session, il ne
  part jamais dans un email : le Hub redirige l'utilisateur dessus immédiatement.
- Si plusieurs workspaces pour ce `hub_user_id` : renvoyer le lien vers le
  **dernier actif**, l'utilisateur switche ensuite dans l'UI.
- `GET /auth/token?t=<token>` consomme le token, pose la session et redirige vers
  le dashboard. À vérifier : ce chemin répond 404 aujourd'hui côté engine.

### 3.3bis Quelle identité le Hub peut réellement fournir (décide le scope du jeton)

**Identités utilisateur — toujours disponibles, les deux :**
- `email` : `User.email` est `@unique` et NOT NULL côté Hub.
- `hub_user_id` : c'est **`User.supabaseUserId` (UUID v4)**, PAS `User.id` qui est
  un cuid. C'est le pont cross-app déjà en service pour Notifuse/Prospection
  (`lib/invitations/attach-downstream.ts:231`). Confondre les deux a cassé
  l'attach cross-app le 2026-05-21 : les apps l'utilisent comme PK Postgres et
  crashent en `invalid input syntax for type uuid`.

**Workspace cible — connu dans un cas sur trois seulement.** Le Hub stocke
`external_tenant_slug` / `external_tenant_id` dans `tenants.metadata.analytics`,
mais ce bloc n'est écrit **que** par `hub link --app analytics`. Or la card
Analytics s'affiche pour trois raisons (`app/dashboard/page.tsx`) :

```ts
showActiveAnalytics = isAnalyticsEnabled || hasLifetimeSiteVitrine || hasServiceAnalytics
```

| Déclencheur | Origine | Workspace connu du Hub ? |
|---|---|---|
| `hasServiceAnalytics` | `metadata.analytics.fallback_url` (posé par `hub link`) | ✅ oui |
| `isAnalyticsEnabled` | flag `TenantApp(app_key='analytics')`, sans métadonnée | ❌ non |
| `hasLifetimeSiteVitrine` | déduit du plan (`notifuse_plan_source`) | ❌ non |

**Conséquence pour le contrat** : `workspace_id` est **optionnel** dans le body.
Le Hub le fournit chaque fois qu'il l'a.

- **Fourni** → l'engine scope le jeton à ce workspace et **refuse**
  (403 `workspace_mismatch`) si l'user n'y a pas accès. Chemin nominal, scope strict.
- **Absent** → l'engine répond **409 `workspace_required`** avec la liste des
  workspaces de l'user (`{ error, workspaces: [{id, name}] }`) plutôt que d'émettre
  un jeton non scopé. Le Hub rappelle en nommant le workspace (un seul → immédiat ;
  plusieurs → choix utilisateur). **Aucun jeton non scopé n'est jamais émis** :
  la complexité du multi-workspace remonte côté Hub, où il y a une UI pour la
  résoudre, et l'engine garde son invariant anti-fuite entre tenants.

### 3.4 Résolution de l'utilisateur

L'engine doit pouvoir retrouver son user local depuis `hub_user_id` **ou** `email`.
Attention au pont d'identité : côté Hub, l'UUID cross-app est
`User.supabaseUserId`, **pas** `User.id` (qui est un cuid). C'est exactement le
piège qui avait cassé l'attach cross-app le 2026-05-21
(`app/api/invitations/[token]/accept/route.ts` le documente). Si l'engine ne stocke
aucun `hub_user_id` aujourd'hui, la résolution par **email** est le repli acceptable
pour la v1.

---

## 4. Blocages d'environnement à débloquer (ne pas les poser soi-même)

### 4.1 ✅ Clé M2M staging rejetée — RÉSOLU (2026-07-28)

> **Résolution** apportée par `analytics-sso-engine` : la clé staging a bien
> divergé de la prod **depuis le passage de Dokploy à Nomad**. La vraie clé vit
> dans la Nomad var `nomad/jobs/analytics-engine-staging` →
> `PLATFORM_ADMIN_API_KEY` (`nomad var get -out=json nomad/jobs/analytics-engine-staging`).
> Vérifiée en live : elle sort 400 sur `tenants.provision` là où la clé prod sort 401.
> Le CLI est corrigé et la clé publiée sous `ANALYTICS_ENGINE_STAGING_PLATFORM_ADMIN_KEY`.
> **Le test bout en bout Analytics sur staging est donc redevenu possible.**

Diagnostic d'origine conservé ci-dessous pour mémoire.

`ANALYTICS_ENGINE_PLATFORM_ADMIN_KEY` est **acceptée en prod** et **rejetée en
staging (401)**. Le CLI `analytics` documente pourtant en dur, commentaire daté du
2026-06-23 (`bin/analytics`, `KEY_VARS`) : *« le PLATFORM_ADMIN_API_KEY du container
staging est IDENTIQUE à celui de prod »*. **Ce n'est plus vrai.**

```
$ analytics --env staging doctor
  health   : 200 ✓
  clé M2M  : présente 49f2a6…(48 chars) ✓
  auth M2M : HTTP 401 ✗ (clé rejetée)
  verdict  : degraded
```

**Conséquence directe** : impossible de provisionner un workspace de test sur
staging, donc **aucun test bout en bout Analytics n'est réalisable** — même une
fois la route SSO livrée. À débloquer en premier : soit republier la clé prod dans
le container staging, soit exposer la clé staging réelle dans `.all-creds.env` et
corriger `KEY_VARS` dans le CLI.

*(La variable `ANALYTICS_ENGINE_STAGING_VERIDIAN_ADMIN_API_KEY` existe mais est une
clé workspace-scoped, pas la clé plateforme — testée, elle donne aussi 401.)*

### 4.2 🔴 `ANALYTICS_ADMIN_KEY` absente de tous les déploiements Hub

`lib/analytics/client.ts` lit `process.env.ANALYTICS_ADMIN_KEY` et **throw**
`'ANALYTICS_ADMIN_KEY not set'` si elle manque. Or elle est **absente du job prod
ET du job staging** (0 occurrence dans les deux `.nomad.hcl`).

Tout appel de `analyticsClient` échoue donc dès la première ligne, en prod. La page
`/dashboard/admin/analytics` (création de tenant, de site, attach GSC) est
non fonctionnelle.

### 4.3 🔴 Le client Analytics du Hub cible l'app LEGACY morte

`lib/analytics/client.ts` appelle `/api/admin/tenants`, `/api/admin/tenants/{id}/sites`…
c'est la surface de l'ancien repo `veridian-analytics` (Next.js/Prisma), **déclaré
mort** par le skill `/analytics-provision` (réécriture du 2026-06-20). Vérifié :
`analytics.app.veridian.site` répond 404, et l'engine ne connaît aucun de ces chemins.

`ANALYTICS_API_URL` pointe pourtant correctement vers l'engine
(`jobs/saas-prod/hub.nomad.hcl:119`) : **l'URL a été migrée, pas le client**. Les
appels partent donc vers le bon hôte avec les mauvais chemins → 404 systématique.

La surface vivante est `/api/admin/platform/*` (`tenants.provision`,
`workspaces.provisionApiKey`, `keys:list`…), authentifiée par
`Authorization: Bearer <PLATFORM_ADMIN_API_KEY>`.

**Ce point est un chantier à part entière** (réécrire le client Hub sur la surface
engine), indépendant de l'autologin mais sur le même périmètre. À arbitrer :
le faire dans la foulée, ou constater que la page admin Analytics du Hub est morte
et l'assumer tant que le CLI `analytics` fait le travail.

---

## 5. Ce qu'il reste à faire côté Hub, une fois l'engine livré

Estimation : une demi-journée, sur le modèle exact de ce qui vient d'être livré
pour Notifuse.

1. `issueAnalyticsAutologin(hubUserId, email)` dans `lib/analytics/` — client HMAC
   §6.1 (reprendre `signRequest` de `lib/notifuse/client.ts`, format identique).
2. Une route Hub qui appelle cette fonction côté serveur et **302** vers
   `magic_link_url`, avec les échecs typés (400 `user_not_in_app` → proposer
   l'activation plutôt qu'une erreur brute).
3. Brancher le bouton « Ouvrir » de la card Analytics du dashboard dessus, au lieu
   du `<a href>` nu actuel (`ServiceCard.tsx`) qui envoie sur l'écran de login.
4. Vérifier que la card n'est proposée que si le tenant a un workspace analytics
   (`metadata.analytics` ou `TenantApp` activé) — sinon on offre un bouton qui
   mènera systématiquement à un 400.
5. Test bout en bout sur staging **une fois §4.1 débloqué**, sur le modèle de
   `e2e/staging-full/22-autologin-notifuse-hub-link.spec.ts`.

---

## 6. Ordre de traitement recommandé

1. ~~Aligner le nom du secret HMAC~~ — **sans objet** : les deux noms sont
   légitimes et les valeurs identiques (§3.2). Rien à faire.
2. Réparer la clé M2M staging (§4.1) — sans ça, rien n'est testable.
3. Livrer `POST /api/sso/issue-magic-link` + `GET /auth/token` côté engine (§3).
4. Brancher le Hub (§5) + test bout en bout staging.
5. Arbitrer séparément le client Analytics legacy du Hub (§4.2 + §4.3).
