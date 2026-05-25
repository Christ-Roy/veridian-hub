# Hub provisionne `veridian-analytics-engine` (M2M) + résout les prospects pas encore signup

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-25
> **Demandé par** : Robert (session 2026-05-25)

## Contexte

Décision vision 2026-05-25 (Veridian Analytics) :

- Provisioning client analytics se fait via le **skill `analytics-provision`** (1 call M2M
  → tenant + workspace + user + API key + invite email).
- Le **Hub** doit savoir provisionner engine de la même manière qu'il provisionne
  Notifuse et Prospection aujourd'hui, pour que le flow soit cohérent côté billing
  + onboarding cross-app.
- **Cas particulier** : les **prospects** (sites client SEO de Robert) ne sont pas
  encore signup côté Hub. Robert veut pouvoir **pré-créer leur tenant analytics**
  avant qu'ils s'inscrivent — quand ils se signup ensuite, le Hub doit **résoudre
  le tenant existant** et le rattacher à leur compte au lieu de le re-créer.

Voir aussi côté engine :
- `veridian-analytics-engine/docs/AUDIT-COMMERCIAL-2026-05-25.md` §1 + §7 P0 #1
- `veridian-analytics-engine/docs/PLATFORM-ADMIN-API.md` (créé par PR `feat/api-m2m-platform-admin`)
- Memory globale : `[[project_vision_2026-05-25_provisioning_telcalls]]`

## Demande

### 1. Câbler `analytics-engine` au pattern provisioning Hub

Aligner sur ce que Hub fait déjà pour Notifuse et Prospection :

- Nouveau client en plan **Free** (ou trial) → Hub appelle
  `POST https://analytics-engine.app.veridian.site/api/admin/platform/tenants.provision`
  avec Bearer `PLATFORM_ADMIN_API_KEY` (env var côté Hub à câbler).
- Body : `{ email, siteUrl, name, phoneNumbers?: [...] }`
- Réponse : `{ workspace_id, owner_user_id, api_key, snippet_html, dashboard_url }`
- Hub stocke `workspace_id` + `dashboard_url` dans son modèle `AppTenant` (ou
  équivalent) pour l'app `analytics`.

### 2. Pattern prospects pré-créés (différent de Notifuse/Prospection)

Aujourd'hui : un user signup Hub → Hub provisionne les apps demandées avec son email.

Cible analytics : Robert peut **pré-créer** un tenant analytics pour un prospect
**avant** que ce prospect ait un compte Hub. Workflow :

1. Robert (ou agent assistant Veridian via skill) déclenche
   `POST /api/admin/analytics/prospects.provision` côté Hub
   - Body : `{ prospectEmail, siteUrl, siteName, phoneNumbers? }`
   - Auth : Bearer admin Hub
2. Hub appelle l'engine pour créer le tenant analytics + récupère `workspace_id`
3. Hub crée un `ProspectAnalyticsBinding(email, analyticsWorkspaceId, snippet, createdAt)`
   dans sa propre DB
4. Plus tard, quand le prospect signup Hub avec `prospectEmail` :
   - Hub vérifie `ProspectAnalyticsBinding(email = signupEmail)`
   - Si match → **rattache le workspace existant** au compte Hub (pas de re-provision)
   - Si pas de match → flow normal (pré-provisioning à la signup)

### 3. Endpoint Discovery analytics (pattern existant Hub)

Déjà spec'd dans tickets Hub précédents (pattern Discovery cross-app
`GET /api/users/by-email` au login). Étendre pour analytics :
quand un user se login Hub, on demande à l'engine
`GET /api/admin/platform/users.lookup?email=...` (à câbler côté engine aussi
si pas déjà fait) pour retrouver le workspace pré-créé.

## Critères d'acceptation

- [ ] Variable d'env `ANALYTICS_ENGINE_PLATFORM_ADMIN_KEY` configurée côté Hub
  (Dokploy compose Hub prod + staging)
- [ ] Service Hub `AnalyticsEngineClient` (nouveau ou dans `lib/analytics/`)
  qui wrap les appels avec retry + timeout
- [ ] Endpoint admin Hub `POST /api/admin/analytics/prospects.provision`
- [ ] Modèle Prisma Hub `ProspectAnalyticsBinding` (migration versionnée)
- [ ] Hook signup Hub qui vérifie le binding et rattache si match
- [ ] Test E2E qui couvre : pré-provision prospect → signup même email → workspace rattaché
- [ ] Doc dans `veridian-hub/docs/ANALYTICS-PROVISIONING.md`

## Dépendances

- ⏳ **Bloqué par** : PR `feat/api-m2m-platform-admin` côté engine (endpoint
  M2M plateforme). Sans ça, le Hub ne peut pas appeler l'engine en M2M propre.
  Statut : en cours, agent `m2m-platform-admin` 2026-05-25.

## Hors scope

- Pricing/billing analytics (Robert a confirmé : analytics reste hors paywall
  pour V1, en bonus du pack Veridian global). Pas de Stripe à câbler côté
  Hub pour analytics.
- White-label / custom domain analytics (Business plan) — sprint plus tard.

## Notes

- Robert ne veut PAS de page admin UI custom dans engine pour ça. Tout passe
  par API M2M + skill.
- Le skill `analytics-provision` côté Robert (CLI agent) reste l'outil pour
  les onboarding manuels. Hub fait la même chose pour les signups
  automatiques + prospect bindings.
