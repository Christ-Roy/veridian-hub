# [HUB] MEGA-E2E post-commercialisation — suite bout-en-bout ultime

> **Sévérité** : 🔴 P0 — gate avant ouverture commerciale large
> **Owner** : agent Hub (orchestrateur) + 5-7 sub-agents Opus (vagues)
> **Créé** : 2026-05-23
> **Demandeur** : Robert — "UNE SUITE E2E ULTIME post-commercialisation qui
>   couvre tous les flows business critiques bout-en-bout"
> **Source de vérité** : ce fichier — toute spec future de la suite MEGA
>   DOIT être référencée ici. Si un agent ajoute / déprécie un scénario,
>   il met à jour ce ticket en même temps.

---

## 0. Pourquoi ce ticket existe

L'existant `e2e/staging-full/` (16 specs, 201 tests, ~5954 lignes) est solide
sur les **routes individuelles** et 4-5 journeys ciblés (trial state machine,
invitation cross-app, provisioning, dispatcher webhook). Mais aucune spec ne
fait **le parcours commercial complet** comme un vrai client :

```
signup OAuth → workspace auto → trial silence → 5 mails Notifuse →
révélation J+2 → CB Pro → débit auto → upgrade Business → refill leads →
churn → grace period → réactivation → cancel + GDPR
```

Robert veut **avant l'ouverture commerciale large** que la suite MEGA
garantisse :

1. **Tout flow client réel** (pas juste des routes API isolées) marche bout-en-bout
2. **Aucune limite de temps résiduelle** après paiement, dans aucune app
3. **Idempotence stricte** (Stripe peut retry, on ne double-débite jamais)
4. **Race conditions** (2 checkouts simultanés, 2 ticks cron, replay webhook) gérées proprement
5. **Sécurité bout-en-bout** (brute force, tampering HMAC, replay nonce, SSRF, XSS sur surfaces neuves)
6. **Cleanup garanti** post-test (aucun tenant zombie, aucun customer Stripe orphelin)

**Périmètre exclu (déjà couvert par d'autres specs/tickets, ne pas dupliquer)** :
- Couverture unit Vitest dispatcher : ticket `2026-05-23-e2e-billing-payment-lifecycle-complet.md` §2
- Branchement clés Stripe preprod en CI : ticket `2026-05-22-ci-e2e-billing-preprod.md`
- Audit trial résidus : ticket `2026-05-23-audit-trial-residus-apres-paiement.md`
- Validation 1er paiement réel : ticket `2026-05-23-validate-dispatcher-first-customer.md`
- Mapping legacy Stripe price : ticket `2026-05-23-legacy-stripe-price-mapping.md`

La MEGA suite **absorbe** ces flows (les rejoue bout-en-bout dans son contexte),
mais ne réimplémente pas leur fix code — elle se contente de tester que le fix
livré ailleurs tient toujours.

---

## 1. Matrice de couverture exhaustive

24 catégories de flows critiques. Chaque catégorie devient un fichier spec
(`e2e/staging-full/mega/<bucket>/<NN>-<slug>.spec.ts`), avec 5-15 assertions
"hardcore" — pas du checkbox checking, des vraies vérifications d'invariants
métier (DB Hub + apps downstream + Stripe API + headers + contenu mails).

> 🔑 **Convention universelle pour TOUS les scénarios** :
> - Préfixe email : `e2e-mega-<bucket>-<spec>-<RUN_STAMP>@e2e.veridian.site`
> - Préfixe tenant : `mega-<bucket>-<RUN_STAMP>-<slug>`
> - `test.afterEach` ferme la BrowserContext + APIRequestContext
> - `test.afterAll` purge les rows DB Hub créées par le spec (matching préfixe)
> - `globalTeardown` (cf §3) purge Stripe + DB cross-app

### Bucket A — Onboarding & Auth (5 specs)

#### A-01 Signup OAuth Google bout-en-bout
- **Scénario** : mock-oauth provider `google` → callback Hub → user créé → workspace auto → tenants Notifuse + Prospection en `free`
- **Asserts** (10) :
  - `hub_app.users` 1 ligne, `supabaseUserId` UUID v4 strict, `mfaSecret IS NULL`, `emailVerified` posé
  - `hub_app.workspaces` 1 ligne avec `ownerId = user.supabaseUserId`, `members` count = 1
  - `hub_app.tenants` 2 lignes (Notifuse + Prospection), `veridianPlan='free'`, `planSource='trial'`
  - `hub_app.tenant_trials` 0 ligne (état `eligible` arrive seulement au signal 5 mails)
  - `Account` Prisma 1 ligne `provider='mock-oauth'` avec `providerAccountId` non-vide
  - Notifuse downstream (DB notifuse-staging via SSH) : workspace existe, `veridian_plan='free'`
  - Prospection downstream (DB prospection-staging via SSH) : workspace existe, `veridian_plan='free'`
  - GET `/dashboard` retourne 200 après login (cookie session valide)
  - Aucun mail trial dans la queue Notifuse (`tenant.activity_threshold_reached` pas émis)
  - `audit_log` : entry `user.signup_completed` avec `provider='google'`
- **Anti-patterns testés** : signup 2× avec même email → 200 (idempotent, account linking via `allowDangerousEmailAccountLinking`)
- **Cleanup** : DELETE user CASCADE (workspace, tenants, accounts, sessions, tenant_trials)

#### A-02 Signup OAuth Microsoft bout-en-bout
- Idem A-01 mais `mockProvider='microsoft'`, `Account.provider='mock-oauth'` avec marker `microsoft`
- Asserts spécifiques : `name` mappé depuis `claims.name`, fallback `email.split('@')[0]` si absent (cf memory `reference_microsoft_entra_oauth.md`)

#### A-03 Signup credentials + MFA email complet
- **Scénario** : POST `/api/auth/signup` (email/password) → check `mfaPending=true` → poll inbox Notifuse (DB query) pour récupérer code MFA → POST `/api/auth/mfa/verify` avec code → session ouverte → `/dashboard` 200
- **Asserts (12)** :
  - `User.mfaSecret` rempli, `mfaPendingCode` hashé bcrypt (jamais clair)
  - Code MFA généré crypto-sûr (entropy ≥ 6 digits)
  - Code expire en 10min strict (TTL en DB)
  - Code consommé = `mfaPendingCode` cleared après verify
  - 3 mauvais codes consécutifs → lockout 5min (rate limit)
  - Rate limit POST `/api/auth/signup` : 5 req/min/IP (assert 429 au 6ème call)
  - Sanitization XSS : `name=<script>alert(1)</script>` → stocké escape, jamais exécuté en `/dashboard`
- **Anti-patterns** : replay du même code MFA après succès → 401 `code_already_used`

#### A-04 Magic link cross-app (Hub → Notifuse)
- **Scénario** : user Hub logué clique "Open Notifuse" → POST `/api/notifuse/magic-link` → redirection signée → Notifuse session ouverte sans saisir mot de passe
- **Asserts (8)** : URL signée HMAC, expire en 5min, single-use (replay = 410), Notifuse `user_sessions` créée, `last_hub_sync_at` mis à jour, refus si user Hub différent du tenant_id, refus si tenant `deletedAt IS NOT NULL`

#### A-05 Magic link cross-app (Hub → Prospection)
- Idem A-04 vers Prospection, contrat HMAC v1.4 strict

### Bucket B — Trial state machine (3 specs)

#### B-01 Trial complet J0 → J+2 → J+15 (paywall, pas CB)
- **Scénario** : signup → wait silence → émit 5× webhook `tenant.activity_threshold_reached` (idempotency_key uniques) → row `tenant_trials` passe `eligible` → SQL helper back-date eligible_at -49h → tick cron → state `trial_active`, `trial_started_at` posé, `trial_ends_at` +15j → back-date `trial_ends_at` -1j → tick cron → state `expired` → GET `/dashboard` affiche bandeau paywall
- **Asserts (15)** :
  - À J+0 : aucun bandeau trial visible (UI assertion Playwright)
  - À J+2 post-5mails : bandeau "Tu es en essai gratuit Pro — il te reste 15 jours" visible
  - À J+12 : `ending_soon_notified=true`, mail "essai bientôt fini" envoyé (DB Notifuse `notifications` ligne avec template `trial_ending_soon`)
  - À J+15 sans CB : state `expired`, tenant Notifuse passe en mode dégradé (GET `/api/messages` côté Notifuse → 200 read-only mais POST → 402 `plan_required`)
  - `cron/trial-tick` est idempotent : 2 ticks consécutifs sur même état = no-op
  - Bandeau J+2 ne s'affiche **PAS** avant 48h post-5mails (assertion à J+1.5)
  - Cron skip `state='converted'` (anti-régression)
  - Aucune notification trial part après conversion (queue Notifuse vide)

#### B-02 Trial → CB ajoutée pendant les 15j → cadeau 30j inconditionnel
- **Scénario** : trial_active → checkout Pro mensuel (carte test `4242 4242 4242 4242`) → état `converted` + 30j bonus → CB retirée via Customer Portal → 30j bonus reste actif → à J+30 débit auto Stripe → invoice succeeded → état `paid` perdure
- **Asserts (12)** : `tenant.metadata.trial_bonus_30d_until` posé, retrait CB ne re-bascule pas en `expired`, cron skip ce tenant, dispatcher webhook reçoit `invoice.payment_succeeded` à J+30 et confirme `paid`

#### B-03 Trial active → upgrade direct (skip trial)
- **Scénario** : trial_active à J+5 → checkout direct Pro → état `converted` immédiat, plus aucun bandeau, plus aucun cron pour ce tenant

### Bucket C — Billing checkout & subscriptions (5 specs)

#### C-01 Trial → Paid Notifuse Pro mensuel (happy path)
- **Scénario** : signup → checkout `notifuse-pro` `month` → Stripe Checkout (carte test) → redirect `/dashboard?session_id=` → poll 10s pour webhook
- **Asserts (15)** :
  - `hub_app.stripe_events` ligne event `checkout.session.completed` + `customer.subscription.created`, `processed_at IS NOT NULL`, `attempts=1`, `error IS NULL`
  - `hub_app.users.stripeCustomerId` rempli, format `cus_*`
  - `hub_app.tenants` Notifuse : `veridianPlan='pro'`, `planSource='stripe'`, `currentPeriodEnd` ≈ NOW+30d
  - `hub_app.subscriptions` 1 ligne `status='active'`, `priceId` correspondant à preprod
  - `hub_app.tenant_trials` Notifuse : `state='converted'` (pas `expired`, pas `trial_active`)
  - Notifuse downstream : `veridian_plan='pro'`, `last_hub_sync_at` < NOW-30s
  - Hub `GET /api/billing/state` retourne `{plan: 'notifuse-pro', interval: 'month', cancelAtPeriodEnd: false}`
  - `audit_log` : `billing.checkout.completed` + `billing.subscription.activated`
  - Aucun email "trial ending soon" en queue
  - Aucun bandeau trial sur `/dashboard`
  - HMAC `update-plan` Notifuse : status 200, headers `X-Veridian-Signature` valides

#### C-02 Trial → Paid Prospection Pro avec welcome leads 2000
- **Scénario** : checkout `prospection-pro` `month` → debit Stripe → welcome leads grant
- **Asserts (10)** :
  - Toutes assertions équivalentes C-01 côté Prospection
  - **NOUVEAU** : Prospection `tenant.leads_balance` = 2000 (welcome leads accordés)
  - `audit_log` : `billing.welcome_leads.granted` quantity=2000
  - `idempotency_key` welcome_leads déterministe `(tenantId, welcome_plan='prospection-pro')`
  - Replay du même event Stripe → leads_balance reste à 2000 (pas 4000)

#### C-03 Bundle Veridian Pro 49€ (2 apps en 1 sub)
- **Scénario** : checkout `veridian-pro` (49€/mo)
- **Asserts (12)** :
  - 1 seule `Subscription` Stripe, 1 seul `priceId`
  - **2 tenants débridés simultanément** sur le même event : Notifuse `veridian_plan='pro'`, Prospection `veridian_plan='pro'`
  - 2 HMAC `update-plan` partis (1 vers Notifuse, 1 vers Prospection)
  - 1 seule entry `billing.checkout.completed` mais 2 entries `billing.subscription.activated.dispatched` (1 par app)
  - Welcome leads Prospection = 2000 (bundle Pro = équivalent prosp-pro)
  - Cancellation = 2 downgrades simultanés (1 event Stripe → 2 dispatches free)

#### C-04 Bundle Veridian Business 149€ (Notifuse Business + Prospection Business)
- Idem C-03 mais Business : white-label custom débloqué sur Notifuse, welcome leads = 8000 Prospection, feature `growth_signals=true`, `api_access=true`

#### C-05 Switch mensuel → annuel (Notifuse Pro)
- **Scénario** : sub active Pro monthly → user clique "Switch to annual" → Stripe créé prorata invoice → nouvel `currentPeriodEnd` +12mo
- **Asserts (10)** : prorata calculé correct (≈12 × prix annuel - reste mois courant), `intervalUnit='year'` Prisma, `audit_log` `billing.plan.switched.interval`, **valeur ajoutée annuelle activée** : `user.veridian_annual=true`, calendar booking link envoyé via Notifuse (mail `annual_onboarding`)

### Bucket D — Upgrade / Downgrade / Plan changes (4 specs)

#### D-01 Upgrade Pro → Business (prorata + delta welcome leads)
- **Scénario** : sub Prospection Pro active → upgrade Business → `customer.subscription.updated` event
- **Asserts (12)** :
  - Prorata invoice générée par Stripe
  - Hub dispatcher reçoit update → veridianPlan='business'
  - Prospection : delta welcome leads accordé (8000 - 2000 = +6000 leads)
  - `idempotency_key` delta différent du welcome initial (pas de double crédit)
  - Features Business débloquées : `growth_signals=true`, `api_access=true`, `feature_white_label=true`
  - Replay event update : leads_balance reste cohérent (pas +6000 de plus)

#### D-02 Downgrade Business → Pro (features perdues, leads jamais retirés)
- **Scénario** : sub Business → downgrade Pro via Customer Portal
- **Asserts (10)** :
  - `veridianPlan='pro'`, features Business gated (assertion : POST `/api/prospection/growth_signals` → 402)
  - **Leads achetés non retirés** : `leads_balance` reste à sa valeur (même si > welcome Pro 2000)
  - `audit_log` `billing.plan.downgraded` avec snapshot des features perdues
  - Aucune purge de data (contacts Notifuse, séquences, etc.)

#### D-03 Cancel + reactivate (grace period)
- **Scénario** : sub active → cancel (cancel_at_period_end=true) → user reste `pro` jusqu'à fin période → reactivate avant expiration
- **Asserts (10)** : `cancelAtPeriodEnd=true` persisté, UI affiche "abonnement annulé, accès jusqu'au DATE", reactivate → `cancelAtPeriodEnd=false`, aucun event `subscription.deleted` émis

#### D-04 Plan offert immune au downgrade Stripe
- **Scénario** : tenant avec `planSource='grant_manual'` (lifetime_site_vitrine) → simuler event Stripe `customer.subscription.deleted` artificiel
- **Asserts (8)** : `veridianPlan` reste `'pro'`, `audit_log` `billing.downgrade.skipped.grant_manual_immunity`, aucun HMAC `update-plan` parti, anti-régression CONTRAT-BILLING §3.3

### Bucket E — Refill leads Prospection (2 specs)

#### E-01 Refill leads one-shot Pro (500 leads)
- **Scénario** : tenant Prospection Pro → `/api/billing/refill-leads/checkout` quantity=500 → Stripe Checkout one-shot → carte test → `checkout.session.completed` avec `metadata.kind='refill_leads'`
- **Asserts (12)** :
  - Dispatcher route vers `handleRefillLeadsCheckout` (PAS `manageSubscriptionStatusChange`)
  - Prix Stripe correspond grille dégressive Pro 100-999 = 0.25€/lead (500×0.25=125€)
  - POST `<prospection>/api/tenants/{id}/credit-leads` reçu avec HMAC valide
  - `idempotency_key` dérivé du `event.id` (déterministe, retry-safe)
  - Prospection `leads_balance` += 500
  - `audit_log` `billing.refill.processed` quantity=500
  - **Replay event** : leads_balance reste à +500 (pas +1000)
  - `payment_status != 'paid'` → skip, retry quand confirmé

#### E-02 Refill leads Business volume max 50k (grille 0.04€/lead)
- Idem E-01 mais grille tier 5 : 50000×0.04 = 2000€, cap 100k respecté (101k → 400 `quantity_exceeds_cap`)

### Bucket F — Webhook robustesse Stripe (4 specs)

#### F-01 Idempotence stricte 5× replay même event
- **Scénario** : POST `/api/webhooks` 5× même payload signé (même `event.id`)
- **Asserts (8)** :
  - 1 seule ligne `stripe_events` (PK = eventId)
  - `processed_at` posé 1 fois, jamais ré-écrasé
  - `tenant.veridianPlan` bascule 1 seule fois en `'pro'`
  - Aucune double facturation (Stripe ne facture qu'1 fois, mais Hub ne dispatch qu'1 fois côté apps)
  - 4 returns `already_processed`, 1 return `processed`
  - Aucun mail welcome dupliqué (queue Notifuse vérifiée)

#### F-02 Signature webhook tampering / wrong secret
- **Scénario** : webhook avec body modifié 1 byte, ou signature avec wrong secret
- **Asserts (6)** : 400 (jamais 200), `stripe_events` non créé, aucun dispatch, log d'audit security `webhook.signature_invalid`, alerte Telegram émise

#### F-03 Webhook customer introuvable (fail-safe)
- **Scénario** : event Stripe avec `customer=cus_doesnotexist` → dispatcher doit fail-safe (alerte Telegram, mais 200 to Stripe pour pas retry inutile)
- **Asserts (6)** : retour 200, event marqué `processed_at` avec `error='customer_not_found'`, `attempts=1`, alerte Telegram envoyée, aucun dispatch côté apps

#### F-04 Webhook downstream HS (fail-open)
- **Scénario** : Stripe event `subscription.created` mais Notifuse downstream renvoie 503 sur `update-plan`
- **Asserts (8)** : NotifuseClient retry 3× backoff exponentiel, après échec → alerte Telegram, Hub `tenant.veridianPlan` mis à jour quand même (state local cohérent), `audit_log` `billing.downstream.unreachable`, prochaine sync cron réessaiera

### Bucket G — Cross-app sync 3 niveaux (3 specs)

#### G-01 Push : webhook Hub → app downstream
- Couvert par C-01 et D-01 ; vérifier complément : header `X-Veridian-Signature` HMAC SHA-256 sur body JSON, header `X-Idempotency-Key`, body shape strict `{tenant_id, plan, plan_source, occurred_at, contract_version}`

#### G-02 Pull : discovery `GET /api/users/by-email`
- **Scénario** : login Notifuse user inconnu → Notifuse appelle Hub discovery → reçoit `{user_id, tenants[]}` → onboarding automatique
- **Asserts (8)** : endpoint répond en <200ms (perf budget), HMAC obligatoire, cache 30s côté Hub, fail-safe si Hub HS (Notifuse fallback signup local)
- ⚠️ **Status** : endpoint pas encore livré (ticket `2026-05-20-hub-discovery-by-email-pattern.md` en attente). Spec à écrire en mode `test.skip` jusqu'à livraison.

#### G-03 Reconcile : cron drift detection
- **Scénario** : créer un drift artificiel (UPDATE direct SQL `tenants.veridianPlan='pro'` côté Hub sans sub Stripe correspondante) → trigger cron `reconcile` → drift détecté → alerte Telegram
- **Asserts (6)** : cron tourne, drift listé, audit_log `drift.detected.tenant_pro_no_stripe_sub`, **PAS de correction auto** (humain décide), ticket auto-créé optionnel

### Bucket H — Multi-membre, invitations, OAuth bounce (3 specs)

#### H-01 Invite team-mate workspace partagé
- **Scénario** : owner Hub crée invitation → email envoyé → invité clique link → accepte → membre dans `workspace_members`, accès `/dashboard` partagé
- **Asserts (12)** : `Invitation.token` UUID + signature HMAC, expire 7j, single-use (replay = 410), email-injection prevention (XSS dans email subject), accepter sur compte logué ≠ email invité → 403, accepter expiré → 410, accepter révoqué → 410
- ⚠️ **Distinction critique** : c'est `Invitation` (workspace Hub), PAS `CrossAppInvitation` (vers Notifuse/Prospection). Cf memory `reference_hub_invitation_model_split.md`.

#### H-02 Cross-app invitation (invité Notifuse from Hub)
- **Scénario** : owner Hub invite email à Notifuse → CrossAppInvitation créée → email avec lien Notifuse signé → accept → user créé côté Notifuse, lié au tenant Hub
- **Asserts (10)** : HMAC `POST /api/invitations/create` valide, ENV `NOTIFUSE_HUB_API_SECRET` consommé (PAS `HUB_INVITATION_SECRET_*` inventé — anti-régression bug invitations-4b 2026-05-21)

#### H-03 OAuth bounce cross-app (Couche 4 contrat HUB §6bis.8)
- **Scénario** : user clique "Login with Google" sur Notifuse → Notifuse redirige vers Hub `/oauth-bounce?provider=google&app=notifuse` → Hub fait OAuth Google → magic link Notifuse signé renvoyé → session Notifuse ouverte
- **Asserts (10)** : redirect URL signée, expire 5min, `state` CSRF preservé entre Notifuse↔Hub, refus si `app` pas whitelist, refus si user Hub n'a pas de tenant pour cette app (auto-provisioning ?), audit_log `oauth.bounce.completed`

### Bucket I — Security stress (4 specs)

#### I-01 Brute force lockout
- **Scénario** : 10× POST `/api/auth/login` mêmes credentials wrong
- **Asserts (8)** : 5 premières renvoient 401, 6-10 renvoient 429 + Retry-After ≥60s, IP loggée dans `audit_log.security.brute_force_lockout`, alerte Telegram à partir de 10 fails

#### I-02 CSRF tokens & double-submit
- **Scénario** : POST `/api/billing/checkout` sans CSRF token / avec token expiré / avec token d'un autre user
- **Asserts (6)** : 403 dans tous les cas, Auth.js v5 csrf check actif sur formes critiques

#### I-03 XSS sanitization sur surfaces neuves
- **Scénario** : injection `<script>alert(1)</script>` dans `name`, `workspace.name`, `tenant.metadata.custom_branding`, `invitation.message`
- **Asserts (8)** : stocké en DB tel quel OU escape côté input (selon design), rendu HTML toujours échappé (React déjà ok, mais vérifier `dangerouslySetInnerHTML` audit), pas d'exécution JS en `/dashboard` ni `/invite/[token]` ni email Notifuse

#### I-04 SSRF + replay HMAC
- **Scénario** : faux webhook app→Hub avec `callback_url='http://169.254.169.254/'` (AWS metadata) → Hub doit refuser ; replay du même HMAC nonce 2× → 2ème → 410 `nonce_replayed`
- **Asserts (8)** : Hub valide URL callback whitelist (pas de SSRF), `audit_log.security.ssrf_attempt_blocked`, nonce stocké en table `hub_app.hmac_nonces` avec TTL 5min, replay refusé

### Bucket J — GDPR & data lifecycle (1 spec)

#### J-01 Tenant deletion cascade GDPR
- **Scénario** : POST `/api/admin/delete-tenant` (admin secret) → cascade purge
- **Asserts (15)** :
  - `hub_app.tenants` soft-delete (`deletedAt` posé, `status='deleted'`)
  - Stripe customer subs cancelled, customer marqué `deleted`
  - Notifuse `POST /api/admin/grant-unlimited` négatif → tenant disabled
  - Prospection idem
  - User Hub : option "delete completely" hard-delete (cascade `User` → `Account`, `Session`, `Workspace`, `Tenant`)
  - `audit_log` `gdpr.tenant_deleted` avec snapshot avant suppression
  - Aucun cron ne touche plus à ce tenant (trial-tick skip `deletedAt IS NOT NULL`)
  - Re-signup même email → nouveau user UUID différent, aucune donnée resucite

### Bucket K — Race conditions (2 specs)

#### K-01 2 checkouts simultanés même user
- **Scénario** : tab1 et tab2 lancent POST `/api/billing/checkout` en parallèle (`Promise.all`)
- **Asserts (8)** : 1 seule Subscription Stripe créée OU les 2 mais Hub idempotence détecte (basé sur `idempotency_key` Stripe SDK), aucune double-facturation, user voit le bon plan final

#### K-02 2 ticks cron simultanés
- **Scénario** : 2× POST `/api/cron/trial-tick` en parallèle même seconde
- **Asserts (6)** : `SELECT FOR UPDATE SKIP LOCKED` actif, 1 seule activation par row, anti-régression S9 spec 10

### Bucket L — Performance budgets (2 specs)

#### L-01 Latence endpoints critiques
- **Scénario** : 50 calls warm cache sur endpoints clés
- **Asserts** :
  - `GET /api/billing/state` (cache HIT) : p95 < 100ms
  - `GET /api/users/by-email` (discovery) : p95 < 200ms
  - `POST /api/billing/checkout` : p95 < 2s (Stripe roundtrip inclus)
  - `POST /api/cron/trial-tick` : p95 < 5s (même avec 1000 rows à scanner)
  - `POST /api/webhooks` (cold path) : p95 < 1s
- **Stratégie** : timer wrapping autour fetch, agréger les samples, fail si dépassé +20% budget

#### L-02 Stress 100 webhooks Stripe simultanés
- **Scénario** : 100 events `customer.subscription.updated` envoyés en `Promise.all`
- **Asserts (5)** : tous traités <30s total, aucun timeout Stripe (>30s), aucune duplication dispatch, DB Prisma pool size suffisante (pas d'erreur `too many connections`)

### Bucket M — Rollback safety (1 spec)

#### M-01 Deploy fail → rollback → client toujours OK
- **Scénario** : simuler deploy v1.0 (cassé) → CI rollback auto à v0.9 → checkout flow encore fonctionnel
- **Asserts (6)** : `/api/health` 200 après rollback, checkout user créé en v1.0 cassé reste activable en v0.9, aucune perte de stripe_events (table persistante)
- **Mode** : spec optionnel, manuel via `pnpm e2e:mega --grep rollback` — n'inclure en CI que si infra supporte

---

## 2. Structure des specs

### Layout cible

```
e2e/staging-full/
├── 01-..16-*.spec.ts          (existants, NE PAS BOUGER)
├── mega/
│   ├── _fixtures/
│   │   ├── mock-oauth.ts      (helper login mock OAuth réutilisable)
│   │   ├── stripe-card.ts     (carte test, customer portal nav)
│   │   ├── db-purge.ts        (cleanup par préfixe `mega-${RUN_STAMP}`)
│   │   ├── stripe-api.ts      (wrapper Stripe SDK preprod, list+cancel subs)
│   │   ├── downstream-db.ts   (SSH+psql Notifuse/Prospection staging)
│   │   ├── perf-budget.ts     (timer p95, assert budget)
│   │   └── audit-log.ts       (read `audit_log` Hub par tenant)
│   ├── A-onboarding/
│   │   ├── 01-signup-oauth-google.spec.ts
│   │   ├── 02-signup-oauth-microsoft.spec.ts
│   │   ├── 03-signup-credentials-mfa.spec.ts
│   │   ├── 04-magic-link-notifuse.spec.ts
│   │   └── 05-magic-link-prospection.spec.ts
│   ├── B-trial/
│   │   ├── 01-trial-paywall-noCB.spec.ts
│   │   ├── 02-trial-CB-bonus-30j.spec.ts
│   │   └── 03-trial-upgrade-direct.spec.ts
│   ├── C-billing-checkout/
│   │   ├── 01-notifuse-pro-monthly.spec.ts
│   │   ├── 02-prospection-pro-welcome-leads.spec.ts
│   │   ├── 03-bundle-veridian-pro.spec.ts
│   │   ├── 04-bundle-veridian-business.spec.ts
│   │   └── 05-switch-monthly-to-annual.spec.ts
│   ├── D-plan-changes/
│   │   ├── 01-upgrade-pro-to-business.spec.ts
│   │   ├── 02-downgrade-business-to-pro.spec.ts
│   │   ├── 03-cancel-reactivate.spec.ts
│   │   └── 04-grant-manual-immunity.spec.ts
│   ├── E-refill-leads/
│   │   ├── 01-refill-pro-500.spec.ts
│   │   └── 02-refill-business-50k-cap.spec.ts
│   ├── F-webhook-robustness/
│   │   ├── 01-idempotence-5x-replay.spec.ts
│   │   ├── 02-signature-tampering.spec.ts
│   │   ├── 03-customer-not-found.spec.ts
│   │   └── 04-downstream-HS-failopen.spec.ts
│   ├── G-cross-app-sync/
│   │   ├── 01-push-webhook-downstream.spec.ts
│   │   ├── 02-pull-discovery-by-email.spec.ts   (skip until livré)
│   │   └── 03-cron-reconcile-drift.spec.ts
│   ├── H-invitations-oauth-bounce/
│   │   ├── 01-invite-workspace-teamate.spec.ts
│   │   ├── 02-cross-app-invitation.spec.ts
│   │   └── 03-oauth-bounce-couche-4.spec.ts
│   ├── I-security/
│   │   ├── 01-brute-force-lockout.spec.ts
│   │   ├── 02-csrf-tokens.spec.ts
│   │   ├── 03-xss-sanitization.spec.ts
│   │   └── 04-ssrf-hmac-replay.spec.ts
│   ├── J-gdpr/
│   │   └── 01-tenant-deletion-cascade.spec.ts
│   ├── K-race-conditions/
│   │   ├── 01-checkouts-simultanes.spec.ts
│   │   └── 02-cron-ticks-paralleles.spec.ts
│   ├── L-performance/
│   │   ├── 01-latence-endpoints-critiques.spec.ts
│   │   └── 02-stress-100-webhooks.spec.ts
│   └── M-rollback/
│       └── 01-deploy-fail-rollback.spec.ts  (optionnel CI)
└── _helpers.ts (existant)
└── _sql-helper.ts (existant — étendre si besoin)
```

### Naming convention

- **Bucket letter** : A-M (24 spec slots, expansible)
- **Spec number** : 2 digits zero-padded
- **Slug** : kebab-case, courts, descriptif business
- **Describe** : `Mega <bucket-letter><spec-number> — <human-readable>` (parsing dans report formatter)

### Helpers partagés à factoriser dans `_fixtures/`

1. **`mock-oauth.ts`** — login OAuth mock avec provider configurable (google/microsoft), réutilise pattern de `12-stripe-billing-flow.spec.ts:48`
2. **`stripe-card.ts`** — naviguer Stripe Checkout, remplir carte test, valider, attendre redirect. Helper `cancelSubscription`, `addPaymentMethod`, `removePaymentMethod` via Customer Portal
3. **`db-purge.ts`** — DELETE cascade par préfixe email/tenant, sécurisé (regex strict `mega-*`)
4. **`stripe-api.ts`** — wrapper Stripe SDK preprod : `listSubscriptionsForCustomer`, `cancelAllSubsForCustomer`, `deleteCustomer`, `triggerEvent` (replay artificiel pour F-01)
5. **`downstream-db.ts`** — SSH `dev-pub` + psql sur containers `notifuse-staging-db` et `prospection-staging-db`. Pattern hérité de `_sql-helper.ts`
6. **`perf-budget.ts`** — wrap fetch dans timer, agréger p50/p95/p99, assert si budget dépassé
7. **`audit-log.ts`** — `assertAuditEntry(tenant, eventType, expectedFields)` strict equality

---

## 3. Protocole cleanup obligatoire

### Niveau 1 — `test.afterEach` (par test)
```ts
test.afterEach(async ({ context, request }) => {
  await context?.close().catch(() => {});
  // request est auto-fermé par Playwright
});
```

### Niveau 2 — `test.afterAll` (par spec)
```ts
test.afterAll(async () => {
  // Purge rows DB Hub créées par ce spec (préfixe mega-<bucket>-<RUN_STAMP>)
  await purgeHubByPrefix(`mega-${BUCKET}-${RUN_STAMP}`);
});
```

### Niveau 3 — `globalTeardown` (fin de run)

Fichier `e2e/staging-full/mega/_fixtures/global-teardown.ts` (à câbler dans `playwright.staging-full.config.ts:globalTeardown`).

Étapes :

1. **Stripe** :
   - `stripe.customers.list({ email: { contains: 'e2e-mega-' } })` → cancel toutes subs actives → delete customer
   - `stripe.events.list({ limit: 100 })` → log les events test pour audit, sans suppression (Stripe ne permet pas de delete events)
2. **DB Hub** (via SSH dev-pub psql) :
   ```sql
   DELETE FROM hub_app.tenant_trials WHERE tenant_id LIKE 'mega-%';
   DELETE FROM hub_app.subscriptions WHERE user_id IN (
     SELECT supabase_user_id FROM hub_app.users WHERE email LIKE 'e2e-mega-%@e2e.veridian.site'
   );
   DELETE FROM hub_app.tenants WHERE user_id IN (...);
   DELETE FROM hub_app.workspaces WHERE owner_id IN (...);
   DELETE FROM hub_app.accounts WHERE "userId" IN (...);
   DELETE FROM hub_app.sessions WHERE "userId" IN (...);
   DELETE FROM hub_app.users WHERE email LIKE 'e2e-mega-%@e2e.veridian.site';
   DELETE FROM hub_app.stripe_events WHERE customer_id IN (...);
   DELETE FROM hub_app.audit_log WHERE tenant_id LIKE 'mega-%';
   ```
3. **DB Notifuse downstream** (via SSH dev-pub psql sur container `notifuse-staging-db`) :
   ```sql
   DELETE FROM workspaces WHERE id LIKE 'mega-%';
   DELETE FROM users WHERE email LIKE 'e2e-mega-%@e2e.veridian.site';
   ```
4. **DB Prospection downstream** (idem) :
   ```sql
   DELETE FROM workspaces WHERE tenant_id LIKE 'mega-%';
   DELETE FROM users WHERE email LIKE 'e2e-mega-%@e2e.veridian.site';
   ```
5. **Processus orphelins** :
   ```bash
   pkill -f chromium || true
   pkill -f playwright || true
   ```
6. **Vérification finale** (fail si non-clean) :
   - `pgrep -c chromium` = 0 (sinon log warning, ne fail pas CI mais affiche)
   - `stripe customers count` test email = 0
   - `SELECT count(*) FROM hub_app.users WHERE email LIKE 'e2e-mega-%'` = 0

### Cleanup en cas de panique

Si un test crash brutalement (out-of-memory, SIGKILL), `globalTeardown` doit
tourner quand même. Playwright garantit `globalTeardown` même en cas de
crash worker, donc OK. **Filet humain** : script `scripts/e2e/mega-purge.sh`
exécutable à la main pour nettoyer tout reliquat ancien :

```bash
# scripts/e2e/mega-purge.sh
# Purge MANUELLE de tous les reliquats E2E MEGA, peu importe le RUN_STAMP.
# À lancer si une CI a crashé en plein milieu et a laissé des tenants test.
# Idempotent : safe à relancer 10× sans rien casser.
```

---

## 4. Stratégie d'isolation cross-tenant

### Principe : 1 tenant unique par scénario

Chaque test génère :
- Email : `e2e-mega-<bucket>-<spec>-<RUN_STAMP>-<test-slug>@e2e.veridian.site`
- TenantId Hub : `mega-<bucket>-<RUN_STAMP>-<test-slug>` (où c'est applicable)
- Stripe customer : auto-créé par checkout, lié au email unique

Aucun scénario ne touche aux tenants des autres. Aucun shared state entre specs.

### Parallélisme

- **Workers=1** pour la suite par défaut (config héritée `playwright.staging-full.config.ts`) — sériel propre
- **Workers=2-4** acceptable pour la suite MEGA car isolation tenant respectée — à activer via `playwright.mega.config.ts` dédié

### Config Playwright dédiée MEGA

Créer `playwright.mega.config.ts` :

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/staging-full/mega',
  timeout: 120_000, // certains flows (trial complet) prennent du temps
  expect: { timeout: 20_000 },
  fullyParallel: true,         // ← isolation tenant garantit la safety
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-mega-staging.json' }],
    ['html', { outputFolder: 'playwright-report-mega', open: 'never' }],
  ],
  globalTeardown: require.resolve('./e2e/staging-full/mega/_fixtures/global-teardown'),
  use: {
    baseURL: process.env.STAGING_URL || 'https://hub.staging.veridian.site',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: process.env.HEADED !== '1', // headless par défaut, HEADED=1 pour debug
    launchOptions: { slowMo: process.env.HEADED === '1' ? 100 : 0 },
  },
  projects: [
    { name: 'mega-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

Et un script `pnpm e2e:mega` :

```json
{
  "scripts": {
    "e2e:mega": "bash scripts/e2e/mega.sh",
    "e2e:mega:bucket": "bash scripts/e2e/mega.sh --grep"
  }
}
```

`scripts/e2e/mega.sh` : équivalent de `staging-full.sh` mais avec config MEGA + budget temps + post-run report.

---

## 5. Gates CI

### Workflow dédié `hub-mega-e2e.yml`

```yaml
name: hub-mega-e2e
on:
  workflow_dispatch:
  push:
    branches: [staging]
    paths:
      - 'e2e/staging-full/mega/**'
      - 'app/api/webhooks/**'
      - 'app/api/billing/**'
      - 'lib/stripe/**'
      - 'lib/billing/**'
      - 'utils/stripe/**'
```

Pas sur `main` (auto-promotion gérée par §20 risk markers). Pas sur tous les push (workflow_dispatch + paths critiques).

### Budget temps

- **Hard cap CI** : 30 min (workflow timeout)
- **Cible** : 20 min avec workers=4
- **Si >30 min** : split en 2 workflows parallèles (A-F dans un, G-M dans l'autre)

### Reporter JSON parseable

Le JSON `e2e-mega-staging.json` doit être lisible par `scripts/e2e/format-staging-report.js` (réutiliser l'existant, étendre pour nouveau format si besoin).

Output dans la reco écrite agent §20 (CI-ARCHITECTURE) :

```
[mega-e2e] 24 buckets / 87 tests
  ✓ Bucket A (Onboarding)        : 5/5 verts (4m12)
  ✓ Bucket B (Trial)             : 3/3 verts (6m44)
  ✓ Bucket C (Billing)           : 5/5 verts (3m20)
  ✗ Bucket F (Webhook)           : 3/4 (F-02 signature failed)
  ...
TOTAL : 86/87 (99%) — 22m18 — budget OK
```

### Intégration §20 protocole risk

- Tier 🟢 LOW : MEGA pas requis (doc/test-only/refactor)
- Tier 🟡 MEDIUM : MEGA optionnel, agent décide
- Tier 🔴 HIGH : MEGA obligatoire (auth, billing, migration, lib partagée)
- Tier 💀 CRITICAL : MEGA + monitoring 30min post-deploy

L'agent ajoute dans sa reco écrite la mention `[mega-e2e]: 86/87 verts (22m)`
ou `[mega-e2e]: skipped (tier-low)`.

---

## 6. Garde-fous reproductibilité

### 1. Pas de bombe temporelle

- **JAMAIS** de `Date.now()` ou `new Date()` hardcodé en assert (cf memory `feedback_bombes_temporelles_tests.md`)
- Pour les flows temporels (trial 15j), TOUJOURS passer par le SQL helper `backdateTrialActive()` qui manipule `eligible_at` / `trial_started_at` directement en DB. Pas `vi.useFakeTimers()` (on est en Playwright, pas Vitest).
- Pour les TTL (5min magic link, 10min MFA), utiliser des `setTimeout` Playwright avec marge confortable (TTL+1s)

### 2. Pas de dépendance d'ordre entre scénarios

- Chaque spec est `independent` : peut tourner seule, peut tourner en parallèle de n'importe quelle autre
- Aucun spec ne lit le state laissé par un autre
- `RUN_STAMP` global par run, mais unique par execution → 10 runs simultanés = 10 tenants distincts

### 3. Cleanup même sur fail

- `test.afterEach` et `test.afterAll` utilisent `try/catch` pour ne JAMAIS throw (sinon Playwright skip les cleanups suivants)
- `globalTeardown` est garanti par Playwright même en cas de crash worker
- Le script `scripts/e2e/mega-purge.sh` est la dernière ligne de défense humaine

### 4. Reproductibilité 10/10

`pnpm e2e:mega` doit tourner **10 fois d'affilée** et passer **10/10**. Toute flake :
- 1 fail isolé sur 10 runs = flake, à investiguer (ajouter `waitForSelector`, augmenter `expect.timeout`)
- 2+ fails même test sur 10 runs = bug réel, fix obligatoire avant merge

Test CI : workflow `hub-mega-e2e-flake-check.yml` (manuel, hebdomadaire) qui lance la suite 10× et stocke les résultats.

### 5. Tolérance Stripe preprod

- Stripe peut avoir des latences variables (webhook delivery 200ms-2s). Toujours `poll` les états DB Hub avec timeout généreux (15s) au lieu d'asserter immédiatement.
- Stripe Test mode n'a pas de Customer Portal aussi rapide qu'en prod. Tolérer 5s de delay sur portal nav.

### 6. Pré-conditions infra

Avant chaque run MEGA :
1. `curl /api/health` → 200
2. `tailscale status` (si staging Tailscale-only) → connected
3. SSH `dev-pub` accessible (pour SQL helper + downstream DBs)
4. Stripe preprod accessible : `stripe customers list --limit 1` → 200
5. Mock OAuth provider actif (`OAUTH_TEST_PROVIDER=true` côté compose staging)
6. ENV `CRON_SECRET`, `NOTIFUSE_WEBHOOK_TOKEN`, `HUB_ADMIN_SECRET` correspondent au compose staging
7. Clés Stripe preprod en GH Secrets (cf ticket `2026-05-22-ci-e2e-billing-preprod.md`)

Script `scripts/e2e/mega-precheck.sh` qui vérifie ces 7 conditions en parallèle et abort si KO.

---

## 7. Bonus : matrice de coverage cross-link

| Bucket | Existant absorbé | Tickets fix coordonnés |
|---|---|---|
| A — Onboarding | 02-oauth-providers-clickable, 03-signup-credentials, 04-oauth-flows | — |
| B — Trial | 10-trial-state-machine-flow | 2026-05-23-audit-trial-residus-apres-paiement (audit code) |
| C — Billing | 12-stripe-billing-flow, 14-stripe-webhook-dispatcher-flow | 2026-05-23-e2e-billing-payment-lifecycle-complet (unit) + 2026-05-22-ci-e2e-billing-preprod (CI) |
| D — Plan changes | — (gap actuel) | 2026-05-23-legacy-stripe-price-mapping (D-04 absorbe) |
| E — Refill leads | — (gap actuel, refill juste livré) | 2026-05-23-refill-leads-end-to-end (done, MEGA vérifie tient) |
| F — Webhook | 09-stripe-webhook-dispatcher | 2026-05-23-validate-dispatcher-first-customer (F-01 absorbe) |
| G — Cross-app | 06-provisioning-cross-app, 08-webhooks-app-to-hub-v14 | 2026-05-20-hub-discovery-by-email-pattern (G-02 bloqué tant que pas livré), 2026-05-22-endpoint-billing-state-reconciliation |
| H — Invitations | 05-invitation-cross-app-flow, 11-invite-page-ux-flow, 11-ui-invite-flow, 07-admin-api-roundtrip | — |
| I — Security | 13-admin-api-security, 16-stress-security | — |
| J — GDPR | — (gap actuel) | À créer si fonctionnalité delete-tenant déjà exposée |
| K — Race | partiellement dans 10 (S9 trial-tick race) | — |
| L — Perf | — (gap actuel) | 2026-05-21-audit-perf-hub (done, MEGA convertit en gate) |
| M — Rollback | — (gap actuel, infra-level) | Référence CI-ARCHITECTURE §20 rollback auto |

---

## 8. Plan d'attaque (vagues d'agents)

### Vague 1 — Fondations (1 agent, ~3h)

**Agent 1 : Helpers + globalTeardown + config MEGA**

- Périmètre :
  - Créer `e2e/staging-full/mega/_fixtures/` (7 helpers listés §2)
  - Créer `e2e/staging-full/mega/_fixtures/global-teardown.ts`
  - Créer `playwright.mega.config.ts`
  - Créer `scripts/e2e/mega.sh`, `scripts/e2e/mega-precheck.sh`, `scripts/e2e/mega-purge.sh`
  - Ajouter scripts `e2e:mega`, `e2e:mega:bucket` dans `package.json`
  - 1 spec exemple `mega/_fixtures/_smoke.spec.ts` qui teste les helpers + cleanup (1 test simple : créer tenant test, l'asserter en DB, le purger)
- Dépendances : aucune, démarre direct
- Risques de conflit : touche `package.json` (modif ciblée scripts, peu conflictogène)
- Output : commit `[risk:low]` `feat(e2e-mega): fondations helpers + config + cleanup`

### Vague 2 — Buckets en parallèle (6 agents, ~6h chacun)

Démarrent après Vague 1 livrée + push staging vert.

| Agent | Buckets | Specs | Estimation |
|---|---|---|---|
| **Agent 2A** | A (Onboarding) + B (Trial) | 8 specs | 6h |
| **Agent 2B** | C (Billing) + D (Plan changes) | 9 specs | 7h |
| **Agent 2C** | E (Refill) + F (Webhook) | 6 specs | 5h |
| **Agent 2D** | G (Cross-app) + H (Invitations) | 6 specs | 6h |
| **Agent 2E** | I (Security) + J (GDPR) | 5 specs | 5h |
| **Agent 2F** | K (Race) + L (Perf) + M (Rollback) | 5 specs | 5h |

Périmètre par agent :
- Création des fichiers spec listés dans son bucket
- Utilisation EXCLUSIVE des helpers de `_fixtures/` (pas de réinvention)
- Asserts complets (10-15 par spec selon matrice §1)
- Cleanup `test.afterAll` par spec
- Push staging par batches de 2-3 specs (max 5 commits par agent)

Dépendances inter-agents :
- **Aucune** entre les agents 2A-2F (isolation tenant garantit)
- **Forte** vs Vague 1 (helpers + config doivent être livrés)

Risques de conflit :
- Tous touchent `e2e/staging-full/mega/` dans des sous-dossiers différents → conflits Git minimaux
- Aucun ne touche au code Hub (lecture seule, c'est de la spec E2E)
- Possible conflit sur `package.json` si plusieurs agents ajoutent des deps : centraliser via Agent 1 ou Agent 3

### Vague 3 — Intégration finale (1 agent, ~3h)

**Agent 3 : CI workflow + report formatter + run validation 10×**

- Périmètre :
  - Créer `.github/workflows/hub-mega-e2e.yml`
  - Étendre `scripts/e2e/format-staging-report.js` pour parser bucket / spec et générer le récap §5
  - Créer `.github/workflows/hub-mega-e2e-flake-check.yml` (manuel, 10× run hebdo)
  - Tourner `pnpm e2e:mega` 10× localement, mesurer flake rate, fix les flakes
  - Compléter docs : `docs/CI-ARCHITECTURE.md` §20bis (intégration MEGA dans risk tiers)
  - Maj `docs/PRICING-VERIDIAN.md` matrice "Implémentations actuelles — Hub" avec colonne `MEGA coverage`
- Dépendances : Vague 2 complète (au moins 80% des specs livrés)
- Risques : aucun (purement intégration)
- Output : commit `[risk:medium]` `feat(ci): workflow MEGA-e2e + flake-check + intégration §20`

### Vague 4 (optionnelle, post-go-live) — Monitoring run-time

Tickets à déposer mais pas implémenter dans le scope MEGA :
- Dashboard Grafana metrics MEGA (pass rate, p95 latence, flake rate)
- Alerting Telegram si flake rate > 5%
- Cron quotidien `pnpm e2e:mega --grep "@critical"` (sub-suite des scénarios critiques)

---

## 9. DoD (Definition of Done)

### MEGA suite livrée
- [ ] Vague 1 livrée : helpers + config + cleanup tournent, `_smoke.spec.ts` vert
- [ ] Vague 2 livrée : 24+ specs créés (1 par scénario §1), tous verts en local 1×
- [ ] Vague 3 livrée : workflow CI actif, 1 run vert manuel, formatter report parseable
- [ ] `pnpm e2e:mega` tourne en < 30 min (mesure CI)
- [ ] `pnpm e2e:mega` 10× consécutifs = 10/10 (flake check passé)
- [ ] Aucun tenant zombie après 10 runs (mega-purge.sh confirme 0 reliquat)

### Documentation
- [ ] `CI-ARCHITECTURE.md` §20bis MEGA intégration livré
- [ ] `PRICING-VERIDIAN.md` matrice MEGA coverage à jour
- [ ] `README.md` racine e2e/ mentionne MEGA + lien

### Garde-fous run-time
- [ ] Workflow `hub-mega-e2e.yml` actif sur push staging (paths critiques) + workflow_dispatch
- [ ] Workflow `hub-mega-e2e-flake-check.yml` planifié hebdo

### Validation finale par Robert
- [ ] Démo 1 run MEGA complet headfull (Robert observe les flows critiques)
- [ ] Validation business : tous les flows commerciaux clés couverts ?
- [ ] Tickets de Vague 4 (monitoring) déposés mais pas requis pour DoD

---

## 10. Risques connus & mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Stripe preprod limits (50 customers/h, etc.) | Tests fail en rafale | Cleanup agressif, batch créations ≤30 customers par run |
| SSH dev-pub instable (timeout 10s) | Cleanup partiel | Retry SSH 3× avec backoff, fallback mega-purge.sh manuel |
| Mock OAuth provider désactivé en prod accidentellement | MEGA tape la prod = catastrophe | Triple garde-fou (DEPLOY_ENV !== prod + OAUTH_TEST_PROVIDER + URL whitelist) — déjà en place cf memory `reference_mock_oauth_provider.md` |
| Flakes sur webhooks Stripe (latence variable) | Pass rate < 100% | Poll avec timeout généreux (15s), pas d'assert immédiat post-checkout |
| Coût Stripe preprod si runs nombreux | Carte préchargée test | Stripe test mode = gratuit, surveiller seulement la latence |
| Conflit Git entre agents Vague 2 | Merge hell | Isolation par sous-dossier `mega/<bucket>/` + chaque agent rebase staging avant push |
| Discovery endpoint G-02 pas encore livré | Spec skip | `test.skip` explicite + reminder ticket parent |

---

## 11. Maillage docs

- **CONTRAT-HUB.md** : référence pour H, G (HMAC, webhooks app→Hub, OAuth bounce §6bis.8)
- **CONTRAT-BILLING.md** : référence pour C, D, E, F (dispatcher, dunning, refill, idempotence)
- **PRICING-VERIDIAN.md** : référence pour B, C, D (trial state machine, grille pricing, bundles)
- **CI-ARCHITECTURE.md §20** : intégration risk markers + protocole agent arbitre
- **Memory** : `reference_mock_oauth_provider.md`, `reference_hub_invitation_model_split.md`, `reference_hub_invitation_hmac_contract.md`, `reference_oauth_supabase_user_id_bridge.md`, `feedback_bombes_temporelles_tests.md`, `feedback_node_env_vs_deploy_env.md`

---

## 12. Status & ownership

- **Status courant** : 🟡 Spec posée 2026-05-23 — attente lancement Vague 1
- **Owner Vague 1** : à assigner
- **Owner Vague 2 (6 agents)** : à assigner après Vague 1 livrée
- **Owner Vague 3** : à assigner après Vague 2 ≥80% livrée
- **Mise à jour** : chaque agent met à jour la section §8 avec son commit SHA après livraison de son bucket

---

## 13. Changements

- **v1.0 (2026-05-23)** : création du ticket racine MEGA-E2E. 24 buckets, 49+ specs.
  Architecture posée, plan vagues d'agents, garde-fous reproductibilité, cleanup
  3 niveaux, isolation tenant stricte, CI workflow dédié. Pas encore d'implémentation.
