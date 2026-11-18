# Rebrancher `lib/analytics/client.ts` sur le contrat NATIF M2M de l'engine (tuer le chemin legacy)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-16
> **Déposé par** : agent `cross-tickets` (sprint decommission bridge/legacy analytics, hors périmètre Hub — NE PAS exécuter côté Hub sans l'agent Hub). Robert route.
> **Ticket parent** : `veridian-analytics/todo/2026-06-15-GIGA-decommission-bridge-workaround-legacy.md` (Lot A)

---

## Contexte

L'analytics Veridian a basculé sur le moteur fork Staminads
(`veridian-analytics-engine`). Le **legacy Next.js** (`analytics.app.veridian.site`,
repo `Christ-Roy/veridian-analytics`) est **condamné** et va être décommissionné.
Sprint en cours pour tuer le workaround. Constat prod vérifié le 2026-06-16 :

- Le container legacy `compose-synthesize-virtual-transmitter-i9bv43-analytics-prod-1`
  est **UNHEALTHY depuis 2 jours** et retourne **404 sur tout** (`/api/health`,
  `/`, `/api/admin/tenants`). Le chemin que ce client appelle est donc **déjà cassé en prod**.
- `lib/analytics/client.ts` pointe sur le legacy :
  - `ANALYTICS_API_URL = https://analytics.app.veridian.site` (legacy Next.js)
  - header `x-admin-key` (env `ANALYTICS_ADMIN_KEY`)
  - routes `/api/admin/tenants`, `/api/admin/sites`, `/api/admin/gsc/sync` — qui
    n'existent QUE sur le legacy.

L'engine expose un **contrat propre M2M** (`docs/PLATFORM-ADMIN-API.md` côté
engine, commit 37cc580) qui remplace tout ça par un seul call Bearer :

- `POST /api/admin/platform/tenants.provision` — provisionne workspace + owner user
  + API key + magic-link en **un seul call M2M**.
- `POST /api/admin/platform/workspaces.provisionApiKey` — clé API pour un workspace
  existant.
- Auth : `Authorization: Bearer <PLATFORM_ADMIN_API_KEY>` (timing-safe, fail-closed).

Vérifié prod 2026-06-16 : l'endpoint natif répond **401 sans Bearer** sur
`https://analytics-engine.app.veridian.site/api/admin/platform/tenants.provision`
→ il est **déjà câblé en prod**, `PLATFORM_ADMIN_API_KEY` configurée côté engine.
Engine `/api/health` → **200**.

## ⚠️ État réel côté Hub prod (vérifié 2026-06-16)

Le compose Hub prod (`compose-back-up-online-pixel-nl2k9p`,
composeId `_kxAHDCv1LhvsdwNRX3Vk`) **ne contient AUCUNE ENV `ANALYTICS_*`**
(34 clés ENV listées, zéro analytics). Conséquence : **le provisioning analytics
depuis le Hub n'est pas opérationnel en prod aujourd'hui** — un appel
`analyticsClient.createTenant()` lèverait `ANALYTICS_API_URL not set`.

→ Ce client est donc surtout consommé par l'**UI admin Hub**
(`app/dashboard/admin/analytics/page.tsx` : `createTenant`, `createSite`,
`attachGsc`, `listTenants`). En prod, ce panel admin est donc soit inutilisé,
soit en erreur. Le provisioning analytics réel passe aujourd'hui par le
**skill `analytics-provision`** (qui tape lui aussi le legacy `x-admin-key`,
ticket séparé dans le GIGA).

## Demande précise

Rebrancher `lib/analytics/client.ts` (et ses consommateurs) sur le contrat
natif M2M de l'engine :

1. **Base URL** : `ANALYTICS_API_URL = https://analytics-engine.app.veridian.site`
   (l'engine, PAS le legacy). Staging : `https://analytics-engine.staging.veridian.site`.
2. **Auth** : remplacer le header `x-admin-key` + env `ANALYTICS_ADMIN_KEY` par
   `Authorization: Bearer <PLATFORM_ADMIN_API_KEY>` (env `PLATFORM_ADMIN_API_KEY`,
   même secret partagé Hub ↔ engine).
3. **Provisioning tenant** : remplacer la cascade `createTenant` + `createSite`
   (2 calls sur le legacy) par **un seul** `POST /api/admin/platform/tenants.provision`.
   Payload attendu (cf doc engine) :
   ```json
   {
     "email": "owner@client.fr",
     "siteUrl": "https://client.fr",
     "name": "Client SA",
     "timezone": "Europe/Paris",        // optionnel
     "currency": "EUR",                 // optionnel
     "phoneNumbers": [{ "e164": "+33...", "source": "seo" }]  // optionnel
   }
   ```
   Réponse 201 : `{ workspace_id, owner_user_id, api_key, snippet_html,
   dashboard_url, password_reset_url, phone_numbers[], user_created }`.
   Erreurs : 400 (body invalide), 401 (Bearer KO / key absente), 409
   (`email_already_exists`), 500 (`provisioning_failed`).
4. **Clé API workspace existant** : `POST /api/admin/platform/workspaces.provisionApiKey`
   (body `{ workspace_id, name, role }`).
5. **GSC / sites / rotate-key / sync** : ⚠️ **ces routes n'ont PAS d'équivalent natif
   aujourd'hui** (le natif M2M ne couvre que provision tenant + clé API). GSC est
   encore dans le bridge Express (Lot C du GIGA — décision en cours sur le port
   natif). **NE PAS les rebrancher en aveugle.** Deux options :
   - retirer les méthodes `createSite` / `attachGsc` / `detachGsc` / `syncGsc` /
     `rotateSiteKey` du client Hub si l'UI admin Hub ne les expose plus (préféré,
     scope minimal Hub),
   - OU attendre que Lot C tranche le sort de GSC (natif vs couche propre) et
     rebrancher ensuite. Coordonner avec l'agent analytics-engine via le GIGA-ticket.
6. **UI admin Hub** (`app/dashboard/admin/analytics/page.tsx` +
   `AnalyticsTenantPanels.tsx`) : adapter aux nouveaux types de réponse
   (le natif retourne `workspace_id` + `snippet_html` + `dashboard_url`, pas
   l'objet `AnalyticsTenant`/`AnalyticsSite` legacy). Lien dashboard à pointer sur
   `analytics-engine.app.veridian.site/workspaces/<workspace_id>` (pas
   `analytics.app.veridian.site/dashboard`, cf `page.tsx:224` et `dashboard/page.tsx:219`).
7. **Câbler l'ENV dans le déploiement (même commit)** — cf memory
   `feedback_env_wire_compose_same_commit` : ajouter `PLATFORM_ADMIN_API_KEY` dans
   le compose Hub (`${PLATFORM_ADMIN_API_KEY:?}`) + workflow `.env` (secret → env →
   heredoc) + `.env.example`. Sinon deploy fail-closed crashe ou code aveugle.
   La même valeur doit exister côté engine (déjà le cas, vérifié 401 prod).

## Ce qui ne change PAS

- `lib/analytics/track-event.ts` est **déjà natif** : il pointe sur
  `analytics-engine.app.veridian.site` (`POST /api/track`), endpoint public
  d'ingestion. **Hors scope de ce ticket** — ne pas y toucher.
- `lib/sync/discovery.ts` et `lib/auth/bounce-apps.ts` référencent
  `ANALYTICS_API_URL` : vérifier ce qu'ils en font (discovery `GET /api/users/by-email`,
  bounce healthcheck). Si la base URL change vers l'engine, confirmer que ces
  endpoints existent côté engine ou ajuster. **À auditer dans le même PR.**

## Impact si non fait

- Le décommission du legacy (Lot D du GIGA) **casserait** tout appel résiduel de
  ce client (déjà cassé de facto en prod : legacy unhealthy 404). Tant que le Hub
  référence `analytics.app.veridian.site`, on ne peut pas couper proprement le
  legacy sans laisser du code Hub qui pointe dans le vide.
- **Ordre impératif** : ce ticket (Lot A) doit être livré et déployé **AVANT** le
  décommission du legacy (Lot D). Le GIGA-ticket bloque D sur A.

## DoD

- [ ] `lib/analytics/client.ts` ne référence plus `analytics.app.veridian.site`
      ni `x-admin-key`.
- [ ] Provisioning via `POST /api/admin/platform/tenants.provision` (Bearer).
- [ ] `PLATFORM_ADMIN_API_KEY` câblée dans compose Hub + workflow + `.env.example`
      (même commit), valeur identique côté engine.
- [ ] UI admin Hub adaptée aux nouveaux types de réponse + lien dashboard engine.
- [ ] GSC : méthodes retirées OU décision Lot C intégrée (pas de rebranchement aveugle).
- [ ] `discovery.ts` / `bounce-apps.ts` audités vs nouvelle base URL.
- [ ] Testé sur staging (`analytics-engine.staging.veridian.site`) AVANT prod.
- [ ] Prévenir l'agent analytics-engine (GIGA Lot A coché) une fois livré.
