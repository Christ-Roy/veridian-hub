# Hub — TODO detaille

> Source de verite strategique : [`../../TODO-LIVE.md`](../../TODO-LIVE.md)
> UI polish solo : [`UI-REVIEW.md`](./UI-REVIEW.md)
>
> Le Hub est le point d'entree SaaS : signup, billing, provisioning, vue workspace.
> **Next.js 15.5.18, App Router, pnpm, Auth.js v5 (Google + Credentials bcrypt), Stripe, Prisma 7 sur veridian-core-db schema hub_app.**
> Supabase Auth dégagée le 2026-05-08 (cf section dédiée plus bas).

## Etat actuel

- **Version** : voir `hub/package.json` (Next 15.5.18, next-auth 5.0.0-beta.30, prisma 7.7.0)
- **Dernier deploy prod** : voir `gh run list -w hub-ci.yml` (à updater workflow — cf dette)
- **URL prod** : https://app.veridian.site
- **URL staging** : https://saas-hub.staging.veridian.site
- **Sante** : 🟢 (post-migration Auth.js + bump CVE Next 15, runtime 0 CVE high, 25 tenants migrés UUIDs préservés)

## Architecture

```
hub/
├── app/                  # Next.js App Router
│   ├── (auth)/           # signup, login, reset, mfa, verify
│   ├── (marketing)/      # pricing, root
│   ├── dashboard/        # workspace, billing, settings, admin, members
│   ├── invite/[token]/   # acceptation invitation
│   └── api/              # routes API, webhooks Stripe + Notifuse
├── auth.ts               # Auth.js v5 config (Google + Credentials bcrypt + MFA)
├── auth.config.ts        # Auth.js edge-safe config (middleware)
├── middleware.ts         # NextAuth middleware
├── lib/
│   ├── auth/get-user.ts  # getCurrentUser, requireUser, userUuid (helpers)
│   ├── admin/check-admin.ts
│   ├── prisma/           # singleton Prisma client lazy proxy
│   ├── notifuse/         # NotifuseClient (Hub → Notifuse fork API)
│   └── stripe/, email/, gtm/, ...
├── utils/stripe/prisma-sync.ts  # upsert Product/Price/Subscription via Prisma
├── utils/tenants/provision.ts   # provisioning Twenty + Notifuse + Prospection
└── prisma/
    ├── schema.prisma     # 15 modèles : User, Account, Session, MfaCode,
    │                     # Workspace, WorkspaceMember, Invitation, Tenant,
    │                     # Subscription, Product, Price, Profile,
    │                     # ProvisioningLog, UsageMetric, VerificationToken
    └── migrations/
        ├── 20260410000000_init_hub_auth/
        └── 20260508000000_add_legacy_tables_workspaces/
```

## Sprint en cours

### P0.8 — Migration GitOps Dokploy + Trivy CI (sprint SPRINT-GITOPS-VERIDIAN.md)

**Objectif** : passer la stack hub Dokploy `compose-back-up-online-pixel-nl2k9p`
de provider Raw → Git, brancher Trivy CI bloquant + Dependabot docker, atteindre
0 CVE CRIT/HIGH sur l'image hub deployed.

Branche : `feat/hub-gitops-migration`. Stack Dokploy : `compose-back-up-online-pixel-nl2k9p`.

**Phase A — Compose Git** ✅ (2026-05-13)
- [x] Snapshot forensique compose live + docker inspect → `/tmp/forensics-hub-gitops-20260513/`
- [x] `infra/services/hub/docker-compose.yml` SHA-pinned (digest `1406f2c1...`), healthcheck explicite, `${DEPLOY_ENV}` blue-green ready
- [x] `infra/services/hub/.env.example` (noms d'ENV, pas de secrets)
- [x] `infra/services/hub/README.md` (procédure deploy + rollback + secrets dans Dokploy UI)
- [ ] PR `feat/hub-gitops-migration` → main, CI verte, merge
- [ ] Dokploy UI : Stack hub → Settings → Provider Raw→Git, branche `main`, path `infra/services/hub/docker-compose.yml`, Auto Deploy + webhook GitHub
- [ ] Premier deploy test + smoke `curl https://app.veridian.site`
- [ ] Test idempotence (commit no-op → redeploy 0 downtime)
- [ ] Test rollback (`git revert` → redeploy précédent)

**Phase B — CI security** ✅ (2026-05-13)
- [x] Workflow réutilisable `.github/workflows/_trivy-image.yml` (CRIT/HIGH bloquant, ignore-unfixed, vuln-type os+library)
- [x] Job `trivy` ajouté à `hub-ci.yml` en `needs: docker`, `deploy-staging` + `deploy-prod` dépendent maintenant de `[docker, trivy]`
- [x] Cron quotidien `hub-security-cron.yml` (3h UTC) sur image deployed `:latest`
- [x] `.github/dependabot.yml` : npm /hub + docker /hub + docker /infra/services/hub + github-actions /

**Phase C — Loop validation 7j**
- [ ] Daily : `gh run list -w hub-security-cron.yml --limit 3` → verte
- [ ] Daily : `obs check security` côté image hub deployed
- [ ] Si PR Dependabot → Trivy CI valide ou bloque correctement
- [ ] À J+7 sans incident : marquer le P0.8 complete, supprimer la branche

**Décisions techniques** :
- Image tag : on garde `${HUB_IMAGE_TAG:-latest}@sha256:${HUB_IMAGE_DIGEST}` pour avoir
  à la fois la lisibilité du tag versionné (`vX.Y.Z` bumped par hub-ci) ET le pinning
  immutable du digest. Le digest est overridable via Dokploy ENV pour bump rapide
  sans push de PR — utile en hotfix.
- Healthcheck dupliqué (Dockerfile + compose) : volontaire pour explicite GitOps audit.
- Routers Traefik gardent les mêmes noms `hub-prod-web/-websecure` → certs Let's Encrypt
  reconduits sans nouvelle émission. Variable `${DEPLOY_ENV:-prod}` injectée dans les
  noms de routers pour préparer le pattern blue-green futur.

### P1.1 — Appliquer le standard cross-SaaS (ref TODO-LIVE)
- [ ] Lire `docs/saas-standards.md` quand cree et auditer le Hub contre la checklist
- [x] Soft delete sur la table `tenants` (migration `supabase/migrations/20260117_add_trial_cleanup_columns.sql` : colonne `deleted_at` + index `idx_tenants_deleted_at`)
- [ ] Audit log `platform_audit_log` Prisma (NOTE: aucun modele Prisma dans le Hub aujourd'hui, cf. alerte sous "Decisions techniques")
- [x] Health check `/api/health` conforme (`app/api/health/route.ts` retourne `{ status, timestamp, service }`)

### P1.4 — OAuth Google + 2FA email opt-in ✅ (2026-04-10, hub-auth-builder)
- [x] Agent MCP Chrome : OAuth Client ID Google Cloud Console cree
  - Scope minimal : `openid email profile`
  - Callbacks : prod + staging + localhost
  - Credentials dans `~/credentials/.all-creds.env` (GOOGLE_OAUTH_CLIENT_ID/_SECRET)
- [x] Auth.js v5 Google provider dans `hub/app/api/auth/[...nextauth]/route.ts`
  (+ CredentialsProvider legacy bridge password dans `hub/auth.ts`)
- [x] Cookies session 3 mois (`maxAge: 60 * 60 * 24 * 90`) dans `auth.config.ts`
- [x] Prisma init + schema `hub_app` sur veridian-core-db (User, Account,
  Session, VerificationToken, MfaCode)
- [x] Table `mfa_codes` Prisma (user_id, code_hash, expires_at, consumed_at)
- [x] Toggle 2FA dans `/dashboard/settings/security` (+ `SecurityMfaToggle.tsx`)
- [x] Page `/auth/mfa` avec input code 6 chiffres + resend (cooldown 30s)
- [x] Template mail "Code de connexion Veridian" HTML inline
  (`lib/email/templates/mfa-code.ts`) via Brevo API HTTP
- [x] Tests vitest : 10 tests (8 lib/mfa + 2 template), 109/109 passent total
- [ ] Tests e2e Playwright (hub n'a pas Playwright, a ajouter en P2)

**Decisions techniques cles** :
- Auth.js v5 cohabite avec Supabase Auth legacy (middleware.ts inchange)
- Prisma 7 utilise `@prisma/adapter-pg` + proxy lazy pour eviter d'ouvrir
  une connexion Postgres au build Next.js
- Rate limit MFA : max 5 codes/heure/user (MfaRateLimitError → HTTP 429)
- Codes 6 chiffres crypto-surs (`crypto.randomInt`), hash bcrypt, TTL 10 min
- `.all-creds.env` mis a jour avec GOOGLE_OAUTH_CLIENT_ID/_SECRET (JAMAIS commit)

### P1.5 — Page membres workspace + invitations ✅ (terminé 2026-05-08, activé via migration)
- [x] Modele Prisma `WorkspaceMember`, `Invitation`, `Workspace`, enum `WorkspaceRole`
- [x] Pages + API + UI adaptée par role + tests vitest
- [x] **Activé** par migration Prisma `20260508000000_add_legacy_tables_workspaces`
  appliquée en prod. PRISMA_READY=true par défaut maintenant (LOT B a viré le mode stub).

### P1.2 — Dissociation UI "SaaS" / "Services de suivi"
- [ ] Home Hub : deux sections distinctes
  - **Vos SaaS** : Prospection, Twenty, Notifuse
  - **Services de suivi** : Analytics (badge BETA)
- [ ] Composant `AppCard` avec support badge `BETA`
- [ ] Lien Analytics : `https://analytics.app.veridian.site`
- [ ] **Entree UI-REVIEW** a creer apres livraison

### P1.6 — Exploiter pleinement les nouvelles routes Notifuse Veridian (sprint 2026-05-08 Notifuse-saasification)

> Le fork `Christ-Roy/notifuse-veridian` (branche `veridian`) expose maintenant
> 7 routes Hub-driven HMAC-signed + 1 endpoint magic link tenant-scoped + 1
> auto-login URL self-contained. Voir `notifuse/README.md` du monorepo pour le
> contrat complet. Le `NotifuseClient` TS existe deja dans `hub/lib/notifuse/`
> et la route `/api/admin/notifuse/magic-link` consomme deja `auto_login_url`.
> Il manque l'integration UI Hub pour exploiter le reste.

**Bouton "Open Notifuse" sur dashboard tenant card** (deja partiellement fait) :
- [x] Bouton appelle `/api/admin/notifuse/magic-link` qui retourne `auto_login_url`
- [x] Click ouvre `auto_login_url` dans nouvel onglet → user logge direct comme owner
- [ ] Verifier que le bouton apparait pour tous les tenants Notifuse (pas juste les nouveaux post-migration)

**Workflow auto-provisioning au signup Hub** (deja partiellement) :
- [x] `provisionNotifuseTenant` dans `hub/utils/tenants/provision.ts` utilise `NotifuseClient.provisionWorkspace`
- [x] Stocke `notifuse_workspace_slug`, `notifuse_api_key`, `notifuse_user_email` dans table `tenants` Supabase
- [ ] Stocker aussi `notifuse_owner_user_id` (UUID retourné par provision) pour cross-ref
- [ ] Affichage live des etapes provisioning (toast / progress) — actuellement silencieux

**Generation token / API key cote Hub** :
- [ ] Page `/dashboard/integrations/notifuse` : afficher l'API key tenant (eyJ... JWT, lecture seule),
  bouton "Reveler" qui demande confirmation 2FA si actif
- [ ] Bouton "Regenerer API key" qui appelle un nouvel endpoint Hub
  `POST /api/admin/notifuse/rotate-api-key` (a creer cote fork Notifuse —
  `WorkspaceService.CreateAPIKey` + invalidation ancienne via revoke)
- [ ] Documenter dans la page : usage de l'API key pour appels SMTP relay,
  webhooks bounce/delivery, etc. (cf `notifuse-templates` skill)

**Magic link a la demande pour user owner** :
- [x] Endpoint Hub `/api/admin/notifuse/magic-link` POST `{tenantId}` → `{autoLoginUrl, magicLink, expiresAt}`
- [x] TenantCard utilise `autoLoginUrl` (preferred, fallback magicLink, fallback console nu)
- [] Bouton "Inviter membre" qui appelle `/api/workspaces.inviteMember` natif Notifuse via API key tenant
- [ ] Liste membres workspace avec roles (cf API `/api/workspaces.members`)
  → meme UI que P1.5 (membres workspace Hub-side) mais lecture cote Notifuse

**Lifecycle Notifuse via Stripe webhooks** (avec override Hub manuel) :
- [ ] **Migration table `tenants`** : ajouter colonnes
  - `notifuse_plan_source` (`stripe` / `manual` / `lifetime_site_vitrine` / `lifetime_partner` / `internal`)
  - `notifuse_plan_set_by_user_id` (qui a defini le plan : Stripe webhook ou Robert)
  - `notifuse_plan_set_reason` (texte libre : "gift_site_vitrine_morel", "partner_program", "test")
  - `notifuse_plan_set_at` (date)
- [ ] Webhook Stripe `customer.subscription.updated` → check `plan_source`. Si
  `=stripe` → `NotifuseClient.updatePlan` (sync). **Si `!=stripe` → log info, ne change pas le plan** (decision business prevaut sur Stripe)
- [ ] Webhook Stripe `invoice.payment_failed` → check `plan_source`. Si `=stripe`
  → `NotifuseClient.suspendWorkspace`. Sinon log warning (Stripe paye autre chose, pas Notifuse)
- [ ] Webhook Stripe `invoice.payment_succeeded` apres suspend → `resumeWorkspace`
- [ ] Cancel subscription → `softDeleteWorkspace` UNIQUEMENT si `plan_source=stripe`
- [ ] **Decision produit** : pas de purge cron silencieuse. Tenant soft-deleted
  reste indefiniment dans Notifuse avec banner "Workspace supprime — reactiver
  avant <date>". Hard delete = action explicite user dans console.

**UI admin Hub : gestion plans tenants** :
- [ ] Page `/admin/tenants/[id]/billing` (admin platform only — `isPlatformAdmin`) :
  - [ ] Affiche plan actuel + source (`stripe` / `manual` / `lifetime_*`)
  - [ ] Dropdown "Changer le plan" avec tous les plans Notifuse + `internal`
  - [ ] Champ texte "Raison" obligatoire (ex: "Cadeau site vitrine Morel Volailles")
  - [ ] Bouton "Appliquer" → POST `/api/admin/notifuse/set-plan` qui :
    - Update `tenants` Hub avec `plan_source=manual` + raison + actor
    - Appelle `NotifuseClient.updatePlan(plan)` cote Notifuse
    - Audit log entry
- [ ] Page `/admin/tenants` : liste tous les tenants avec colonne "Plan Notifuse"
  + filter "Plans non-Stripe" pour voir les cadeaux/partenaires

**Skill Claude `/notifuse-grant-lifetime`** :
- [ ] Quand Robert finit un site vitrine via `/create-site`, propose
  automatiquement de provisioner Notifuse `lifetime_site_vitrine` pour le client
- [ ] Skill input : `tenant_id`, `client_email`, `lifetime_plan` (defaut `lifetime_site_vitrine`)
- [ ] Output : auto_login_url a partager au client + email d'onboarding
- [ ] Audit log Hub : "lifetime granted by Robert for site vitrine X"

**Webhook Hub recoit events Notifuse** (deja fait pour squelette) :
- [x] `hub/app/api/webhooks/notifuse/route.ts` recoit events HMAC, idempotence, dispatch
- [x] Migration colonnes `notifuse_suspended_at`, `notifuse_deleted_at`, `notifuse_emails_sent_this_month`, etc.
- [ ] UI dashboard : afficher quota mois en cours + suspended/deleted state + bouton resume si suspended
- [ ] Email tenant si `tenant.quota_exceeded` event recu (TODO marque dans le code receiver)

**Skill Claude `/notifuse-provision`** (parallele aux autres provisioning skills) :
- [ ] Wrapper du flow Hub provision (HMAC POST `/api/tenants/provision` → magic link)
- [ ] Permet a Robert de provisioner un tenant Notifuse pour un client en 1 commande
- [ ] Aligne avec patterns `analytics-provision`, `cms-provision`

## Backlog Hub-specific

- [ ] Audit hot paths Supabase admin API (P0.2) — verifier que le cache 5min est bien applique partout
- [ ] Page `/billing` : historique factures Stripe, upgrade/downgrade plan
- [ ] Page `/settings/workspace` : nom, logo, domaine custom
- [ ] Onboarding post-signup : wizard 3 etapes (workspace name, invite members, choose plan)
- [ ] Email verification obligatoire au signup (via Brevo + token)
- [ ] Password reset flow complet (token email + page reset)

## Chantier — Hub × Apps : synchronisation tenants + Stripe trial intelligent

> Le Hub orchestre le cycle de vie tenant cross-apps. Aujourd'hui chaque app a sa propre
> DB tenants et son propre login, ça marche mais il manque la couche d'orchestration.
> **Reprise** : `tmp/PROMPT-RESUME-HUB-SYNC.md` (prompt de reprise détaillé).

**Synchronisation tenants Hub → Apps**
- [ ] Mécanisme provisioning à la demande : Hub → POST API provisioning de l'app
- [ ] Pas de duplication tenant entre Hub et apps (mapping `hub_tenant_id ↔ app_tenant_id`)
- [ ] Hook signup Hub : ne PAS provisionner les apps tant que l'utilisateur ne les active pas
- [ ] Endpoint `POST /api/admin/tenants/:id/activate-app` (app: prospection|analytics|notifuse|twenty)
- [ ] Désactivation symétrique : `POST /api/admin/tenants/:id/suspend-app`

**Stripe trial intelligent (par app, pas par tenant)**
- [ ] Le trial Stripe d'une app commence quand le tenant **active** cette app (pas au signup Hub)
- [ ] Chaque app a son propre webhook Stripe `/api/webhooks/stripe` (standard saas-standards.md)
- [ ] Le Hub orchestre : tenant active Analytics le 15/04 → trial Analytics 14j à partir de cette date
- [ ] Table de mapping `tenant_app_subscription` (tenant_id, app, stripe_subscription_id, trial_started_at, trial_ends_at, plan_status)

**Magic link cross-app**
- [ ] Hub génère JWT 5min signé avec `HUB_AUTH_SECRET`
- [ ] L'utilisateur clique sur "Ouvrir Analytics" depuis le Hub → redirect avec token
- [ ] L'app valide le token auprès du Hub (`POST /api/auth/verify-magic-link`)
- [ ] Si valide → connexion auto + cookie session app
- [ ] Évite de gérer des mots de passe synchronisés entre apps
- [ ] Documenter dans saas-standards.md comme contrat standard

**Data bridge Analytics → Twenty CRM**
- [ ] Quand un tenant Twenty est créé, pousser les data Analytics pertinentes
  (contacts forms, appels SIP, métriques GSC) comme activités/contacts dans Twenty
- [ ] API GraphQL Twenty déjà en place, juste le mapping à écrire
- [ ] Job cron toutes les heures : sync incrémentale (timestamp last sync)

**Card Analytics dans le Hub** (déclinaison de P1.2 ci-dessus)
- [ ] Cartes "Vos SaaS" vs "Services de suivi" sur la home
- [ ] Composant `AppCard` avec badge `BETA`
- [ ] Lien vers `analytics.app.veridian.site` (avec magic link une fois implémenté)

## Chantier — Hub admin unifié (vue cross-apps)

> À étendre quand les autres apps seront matures. Pas prioritaire tant que le SSO avancé
> n'est pas en place (cf. chantier douloureux dans TODO-LIVE).

- [ ] Vue unifiée d'un tenant : blocs Prospection / Twenty / Notifuse / Analytics côte à côte
- [ ] Actions centralisées : suspendre, reset quota, force sync Twenty, resend invitation
- [ ] Impersonate workspace (login as avec audit log) — utile pour le support
- [ ] Dashboard admin global : liste tenants, filtres, recherche full-text
- [ ] Audit log `platform_audit_log` Prisma sur toutes les actions admin

## Bugs connus

- [ ] `checkTrialExpired = return false` en prod (hack P0.1) — le trial ne bloque plus personne
- [ ] Pas de validation email au signup (on peut creer un compte avec un email bidon)

## Decisions techniques

- **Prisma 7 + veridian-core-db schema hub_app** (résolu 2026-05-08) : Hub partage la DB
  Postgres dédiée avec Analytics. 15 modèles dans `schema.prisma`. Migrations SQL appliquées
  manuellement sur prod (pas via `prisma migrate deploy` car pas de shadow DB accessible).
- **Auth.js v5 stack unique** (post-migration 2026-05-08) : Supabase Auth dégagée. Hashes
  bcrypt $2a$ Supabase préservés tels quels dans `Account.access_token` (provider=credentials),
  lus nativement par bcryptjs.compare. Aucune ré-authentification utilisateur.
- **Bridge UUIDs** : `User.id` TEXT (cuid pour nouveaux signups, UUID stringifié pour migrés)
  ≠ `Tenant.userId` UUID (préservé Supabase pour FK + références externes Twenty/Notifuse).
  Pont via `User.supabaseUserId` TEXT. Helper `userUuid(user)` à utiliser systématiquement
  dans queries Prisma (`prisma.tenant.findMany({ where: { userId: userUuid(user) } })`).
- **Cookies 3 mois** : decision explicite pour eviter que les tenants perdent leur compte
  facilement. Le 2FA email opt-in compense pour la securite.
- **Impersonate** : routes `/api/admin/impersonate` créent une vraie Session Auth.js (Session
  table + sessionToken). Endpoint `/api/auth/impersonate-callback` à créer pour set le cookie
  cross-domain (TODO LOT D).
- **Twenty = hands-off** : aucun fork, uniquement API GraphQL. Custom features dans le Hub.
- **Notifuse = fork `Christ-Roy/notifuse-veridian`** : 7 routes Hub HMAC + magic link tenant-scoped.
  NotifuseClient TS dans `hub/lib/notifuse/`. ⚠️ `NOTIFUSE_HUB_API_SECRET` non configuré côté
  Hub post-migration → provisioning échoue pour nouveaux signups (cf dette).

## ✅ Migration Supabase → Auth.js v5 (TERMINÉE 2026-05-08)

Bascule prod réussie le 08/05/2026 matin. Voir
`session_2026-05-08_hub_authjs.md` en memory pour le retex complet.

**Stack actuelle** : Next 15.5.18 + Auth.js v5 + Prisma 7 + `veridian-core-db` schema `hub_app`.

**Image prod** : `ghcr.io/christ-roy/veridian-dashboard:hub-authjs-staging`
**Compose Dokploy** : `_kxAHDCv1LhvsdwNRX3Vk` (`hub-authjs`)
**Image rollback** : `ghcr.io/christ-roy/veridian-dashboard:rollback-pre-authjs-20260508`

### Dette post-migration à traiter (priorisée)

**🔴 Bloquantes pour nouveaux signups**
- [ ] **`NOTIFUSE_HUB_API_SECRET`** non configuré côté Hub (agent C a refacto le client Notifuse vers la nouvelle API HMAC du fork `Christ-Roy/notifuse-veridian`). Provisioning Notifuse échoue → `[Notifuse Provision] Error: Notifuse client not configured` dans les logs. Action : générer le secret côté Notifuse server + injecter dans ENV Dokploy `hub-authjs`.

**🟠 Avant merge sur main (ordre obligatoire pour ne pas casser prod)**
- [ ] Mettre à jour `.github/workflows/hub-ci.yml` job `deploy-prod` : `COMPOSE_ID` legacy `Rnt_Jz4BhkcyEJ2D6Bugb` → nouveau `_kxAHDCv1LhvsdwNRX3Vk`. Sinon premier merge main = la CI pull `:latest` et redeploy le compose legacy vide → prod KO.
- [ ] **Promouvoir image** `:hub-authjs-staging` → `:latest` (re-tag GHCR) APRÈS update workflow, sinon pas grave mais ça unifie. Sinon laisser tag intermédiaire jusqu'à J+30.
- [ ] Merger `feat/hub-authjs-migration` dans main après 24h de stabilité prod confirmée.

**🟡 Polish post-migration**
- [ ] Helpers e2e Supabase non migrés. `__tests__/api/notifuse-webhook.test.ts` supprimé (test écrit pour vieille structure idempotence). À recréer en Auth.js si on remet une CI e2e Hub.
- [ ] **Endpoint `/api/auth/impersonate-callback`** à créer pour set cookie httpOnly cross-domain. La route `/api/admin/impersonate` génère déjà une vraie Session Auth.js + sessionToken, mais il manque le handler côté target user pour le poser en cookie (sinon admin reçoit token mais ne peut pas l'utiliser).
- [ ] Champs `notifuse_suspended_at`, `notifuse_deleted_at`, `notifuse_emails_sent_this_month` actuellement stockés dans `Tenant.metadata` JSON (par LOT B faute de colonnes dédiées). Ajouter au schema Prisma `Tenant` si on veut indexer dessus.
- [ ] Idempotence webhook Notifuse stockée dans `tenant.metadata.notifuse_processed_events` (slice 200). Créer table dédiée `NotifuseEventProcessed` pour scaler.
- [ ] **Page reset password** finale (`/auth/reset?token=...`) : agent A a livré un MVP fonctionnel (VerificationToken + bcrypt update Account.access_token + anti-énumération). À tester end-to-end avec un vrai email avant de communiquer aux users.
- [ ] **Page `/dashboard/integrations/notifuse`** : voir P1.6 plus haut, à reprendre une fois NOTIFUSE_HUB_API_SECRET en place.

**🟢 Cleanup tardif (J+30 minimum, fenêtre rollback expirée)**
- [x] **2026-05-08** : 10 containers Supabase stoppés (storage, auth, studio, realtime, meta, rest, supabase-db, imgproxy, kong, functions) avec `restart=no`. Audit confirmé aucun autre service ne lit Supabase (Hub/Prospection ont les ENV legacy mais ne les utilisent pas runtime). RAM libérée : ~1.8 Gi (5.4→3.6 Gi). Volumes intacts pour rollback.
- [ ] **J+30 (08 juin)** : suppression définitive du compose Dokploy `compose-parse-digital-alarm-974mhw` + des volumes Docker associés (perte irréversible des hashes bcrypt $2a$ Supabase et de la table `auth.users`). Garder les backups `~/backups/hub-supa-prebascule-20260508-*.sql.gz` 90j minimum.
- [ ] Retirer les variables d'env Supabase legacy du compose `hub-authjs` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Aujourd'hui gardées 30j pour safety.
- [ ] Supprimer le compose Dokploy legacy `Rnt_Jz4BhkcyEJ2D6Bugb` (web-dashboard) **uniquement après update du workflow** (sinon CI plante).
- [ ] Supprimer DNS `hub-green.app.veridian.site` Cloudflare (plus utilisé après bascule).
- [ ] Cleanup memory `project_auth_centralization.md` (2026-04-03) — décrit plan obsolète, remplacé par `session_2026-05-08_hub_authjs.md`.

### Leçons apprises (à appliquer aux autres apps)

- **Next 15 useSearchParams + Suspense obligatoire** : tout Client Component qui consomme `useSearchParams()` doit être enveloppé de `<Suspense>` sinon crash client-side intermittent (cas vécu sur AuthTracker dans `app/dashboard/layout.tsx` post-bascule). Grep systématiquement `useSearchParams` à chaque migration Next 15.
- **Next 15 params async** : `params: Promise<{...}>` puis `await params` dans pages dynamiques + route handlers. 2 fichiers concernés sur Hub (`api/workspace/members/[id]`, `app/invite/[token]`).
- **`corepack prepare pnpm@latest`** = piège : pnpm 11 exige Node 22+, donc plante sur node:20-alpine. **Pin obligatoire** : `corepack prepare pnpm@10.33.0 --activate`.
- **2 lockfiles incohérents** = piège silencieux : si `package.json` mis à jour via `npm install`, le `pnpm-lock.yaml` devient obsolète et le Dockerfile `pnpm install --frozen-lockfile` plante. Toujours vérifier le PM utilisé par le Dockerfile AVANT d'installer en local.
- **3 agents parallèles sur lots disjoints** scalent bien : 56 fichiers refacto en 1 matinée (vs 2 jours sur Prospection en mode séquentiel). Critère : agents reçoivent les helpers partagés DÉJÀ créés par le lead (lib/auth/get-user.ts dans ce cas).
- **Compte test mdp Robert** : `Mincraft5*55` est le mdp Hub de Robert sur **les deux comptes** (`brunon5robert@gmail.com` ET `robert.brunon@veridian.site`). Mon premier test curl a échoué car le payload n'envoyait pas correctement les cookies CSRF, pas un problème de mdp.

### Containers prod (référence)

- App GREEN active : `compose-back-up-online-pixel-nl2k9p-hub-authjs-1`
- App BLUE legacy stoppée : `compose-parse-digital-bandwidth-xfd9mu-web-dashboard-1`
- DB cible : `compose-parse-multi-byte-feed-ywg73b-veridian-core-db-1` (hostname `veridian-core-db`)

## Notes agents (chantiers en cours)

_Section mise a jour par les agents au fil de l'eau. Indiquer : qui bosse sur quoi,
blockers, questions en attente pour Robert._

**2026-05-08 — Migration Hub Auth.js v5 + Next 15.5.18 (lead + 3 agents parallèles)** :
- Bascule prod réussie (cf section dédiée + `session_2026-05-08_hub_authjs.md`).
- Stub Prisma P1.5 (PRISMA_READY=false) résolu : LOT B a activé Prisma direct, les
  modèles workspace/invitation sont en prod.
- Question Workspace auto-création non tranchée : provision.ts ne crée toujours pas
  de Workspace par défaut. À traiter quand on remettra l'UX onboarding.

**2026-04-10 — hub-members-builder (P1.5)** : ✅ obsolete, livraison stub résolue par migration 2026-05-08.

## Recently shipped

- **2026-05-08** — 🎉 **Migration Hub Supabase Auth → Auth.js v5 + Prisma 7 + bump Next 15.5.18** (5 CVE high résolues, 165→11 vulns, 0 critical/high). 25 tenants migrés UUIDs préservés, hashes bcrypt $2a$ Supabase préservés tels quels. Bascule blue/green Dokploy en 1 matinée via 3 agents parallèles. Fix post-bascule : Suspense wrap AuthTracker/PurchaseTracker (Next 15 useSearchParams CSR bailout) + ADMIN_EMAILS étendu pour les 2 comptes Robert.
- **2026-04-10** — Audit sync TODO : `/api/health`, `tenants.deleted_at`, `/api/webhooks` Stripe, `billing.config.ts` plans, `/api/admin/*` deja en place et non suivis dans la TODO
- **2026-04-07** — `.env.example` mis a jour, docs legacy archives
- **feat preexistante (hors TODO)** — `/api/admin/impersonate` deja implemente (prevu en P3.6 dans TODO-LIVE, a repositionner)
- **feat preexistante (hors TODO)** — `/api/prospection/regenerate-login` + colonnes `prospection_provisioned_at` / `prospection_login_token` sur tenants
