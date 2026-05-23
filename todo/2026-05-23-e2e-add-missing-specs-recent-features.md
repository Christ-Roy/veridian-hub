# [HUB] E2E — ajouter specs manquantes pour les 5 features livrées cette session

> **Sévérité** : 🟡 P1 — features en staging sans couverture E2E réelle
> **Owner** : sub-agent Opus (à spawner après les fixes E2E actuels)
> **Créé** : 2026-05-23

## Contexte

Cette session, 7 sub-agents ont livré 7 features sur staging. Toutes ont des unit tests Vitest (Mode Nuclear), mais 5 n'ont **AUCUN E2E** dans `e2e/staging-full/` :

| Feature | Code livré | E2E manquant |
|---|---|---|
| Refill leads Stripe Checkout one-shot | `app/api/billing/refill-leads/checkout/route.ts` + dispatcher | `e2e/staging-full/17-refill-leads-flow.spec.ts` |
| OAuth bounce Couche 4 | `app/api/auth/bounce/{prepare,complete}/route.ts` + cookie signé | `e2e/staging-full/18-oauth-bounce-cross-app.spec.ts` |
| Hub discovery by email | `app/api/users/by-email/route.ts` + HMAC GET | `e2e/staging-full/19-discovery-by-email.spec.ts` |
| Billing state poll endpoint | `app/api/tenants/[tenantId]/billing-state/route.ts` | `e2e/staging-full/20-billing-state-poll.spec.ts` |
| Tenant sync 3 niveaux | `lib/sync/*` + cron reconcile + handlers webhook étendus | `e2e/staging-full/21-tenant-sync-reconcile.spec.ts` |

## Scope — un fichier spec par feature

Chaque spec DOIT couvrir (style spec 14 ou 16, niveau hardcore) :

### 17-refill-leads-flow.spec.ts
- S1 : Checkout one-shot Free → 0 leads achetables (plan freemium = pas de tarif)
- S2 : Checkout Pro 500 leads → calcul prix correct selon grille shared (0.25€/lead = 125€)
- S3 : Checkout Business 50k leads → tarif minimum 0.04€/lead
- S4 : Cap 100k leads dépassé → 400 invalid_quantity
- S5 : Webhook checkout.session.completed → credit-leads HMAC vers Prospection
- S6 : Retry sur fail 5xx Prospection (3 tentatives)
- S7 : Idempotence : 2 checkouts différents même event Stripe replay → 1 seul crédit
- S8 : Tax behavior cohérent avec les subs (à confirmer)

### 18-oauth-bounce-cross-app.spec.ts
- S1 : `/login?next=https://notifuse.veridian.site/dashboard` → cookie posé + redirect /login
- S2 : User OAuth → bounce vers notifuse magic link → arrive sur dashboard
- S3 : `next=https://evil.com` → silently dropped (anti open-redirect)
- S4 : `next=https://veridian.site.attacker.com` → drop
- S5 : Cookie expiré → fallback /dashboard
- S6 : User sans accès à l'app cible → 400 user_not_in_app → page erreur propre
- S7 : Idempotence : refresh après succès → pas de re-bounce (cookies vidés)
- S8 : App downstream 5xx → page erreur, cookies vidés
- S9 : Anti-loop : `next=https://hub.veridian.site/anything` → drop
- S10 : Anti cross-pollution : staging next en prod → drop

### 19-discovery-by-email.spec.ts
- S1 : Email inconnu → 200 {exists:false, tenants:[]}
- S2 : Email mono-app → 200 avec 1 tenant + role
- S3 : Email multi-app → 200 avec N tenants
- S4 : HMAC invalide → 401
- S5 : Secret pas configuré → 503 (pas 401 silencieux)
- S6 : Rate limit pre-verify (60/min/IP) → 429
- S7 : Rate limit per-app (30/min/app post-HMAC) → 429
- S8 : Isolation : notifuse rate-exhaust n'affecte pas prospection
- S9 : Anti-énumération : same shape entre known/unknown email
- S10 : Query params réordonnés → signature toujours valide (canonical sort)
- S11 : Member d'un workspace d'un autre user → role=member

### 20-billing-state-poll.spec.ts
- S1 : Notifuse caller voit notifusePlan, pas prospectionPlan (isolation app)
- S2 : Cache HIT sur 2e appel (header X-Veridian-Cache=HIT)
- S3 : Rate limit 60/min/secret → 429
- S4 : Usurpation x-veridian-app (secret désync) → 401
- S5 : Tenant inconnu → 404
- S6 : Drift timestamp > 5min → 401
- S7 : Shape strict §6.3 (6 champs exacts, pas plus pas moins)
- S8 : Mapping plan_source v1→v2 correct (manual → grant_manual, trial → stripe_trial, etc.)
- S9 : Trial expiré sans Stripe sub → status=downgrade_auto
- S10 : Refill balance présent uniquement pour app=prospection

### 21-tenant-sync-reconcile.spec.ts
- S1 : Discovery pull — Hub interroge Notifuse + Prospection en parallèle, 1 app timeout → app_unreachable mais reconcile continue
- S2 : Webhook push — Notifuse envoie tenant.suspended → snapshot Hub mis à jour
- S3 : Webhook push — payload malformé → 400, snapshot inchangé
- S4 : Cron reconcile — 0 drifts → pas d'alerte Telegram
- S5 : Cron reconcile — drifts > threshold → alerte Telegram
- S6 : Cron reconcile — autoRepair=true ignoré (P0 lock dry-run forcé)
- S7 : Cron auth Bearer manquant → 401
- S8 : Cron CRON_SECRET absent en env → 500 (fail-loud)
- S9 : plan_mismatch + status_mismatch détectés en parallèle
- S10 : tenant_missing_app (Hub connaît app, discovery 404) émis
- S11 : tenant_extra_app (Hub ne connaît pas, discovery trouve) émis

## Définition of done

- [ ] 5 specs créées sous `e2e/staging-full/`
- [ ] Chaque spec passe en local : `HEADED=0 pnpm exec playwright test e2e/staging-full/17-*.spec.ts` (etc.)
- [ ] Suite complète `pnpm e2e:staging:full` passe à 100%
- [ ] Push staging
- [ ] Mode Nuclear : si les routes/lib correspondants ont déjà leurs unit tests Vitest, OK (pas de redoublonner)

## Contraintes

- Style hardcore : reproduire à la lettre la qualité de specs 14 et 16 (events business + edge cases + sécu + idempotence)
- Cleanup obligatoire : `test.afterEach(async ({ context }) => await context.close())` dans chaque spec
- Marker commit `[risk:medium]`
