# Audit — résidus trial après paiement (cross-app)

> **Date** : 2026-05-24
> **Ticket** : `todo/2026-05-23-audit-trial-residus-apres-paiement.md`
> **Auditeur** : agent Hub (Opus)
> **Promesse à tenir** : *"Client paie = plus aucune limite, plus aucun
> bandeau, plus aucun mail trial, partout, immédiatement."*

---

## TL;DR

| Périmètre | Gap trouvé | Sévérité | Fix |
|---|---|---|---|
| Webhook Stripe `manageSubscriptionStatusChange` | Ne purge PAS `tenant_trials` quand sub devient active → état `trial_active` reste pourri en DB | 🔴 P0 | ✅ Fix livré : `tenantTrial.updateMany(state IN trial_*) → 'converted'` |
| Cron `processEndingSoon` | N'a aucun filtre Stripe-sub → mail "expire dans 3j" envoyé à un user qui paie déjà si `tenant_trials.state='trial_active'` persiste | 🔴 P0 | ✅ Fix livré : batch resolve `hasActiveSub` + skip + auto-purge à `converted` |
| Bandeau `FreemiumBanner` UI | Aucun, déjà gated `hasActiveSubscription` dans `app/dashboard/layout.tsx:98` (cf code) | 🟢 OK | — |
| `SubscriptionCard` page billing | `isTrialing = subscription.status === 'trialing'` (Stripe natif) → masqué dès que sub passe `active` | 🟢 OK | — |
| `billing-state.ts` endpoint POLL apps | `stripe_subscription_id` prime sur `trial_state` dans `mapPlanSource` → plan_source=stripe dès qu'une sub existe | 🟢 OK | — |
| Webhook Notifuse handlers | Aucun handler ne touche `tenant_trials` (responsabilité Hub, pas Notifuse) | 🟢 OK | — |
| Cron `processFinalize` phase 3 | OK : tenant avec sub → `state='converted'`, pas de downgrade ni d'email | 🟢 OK | — |
| Downstream Notifuse — purge `veridian_plan` après upgrade | Hors scope Hub : audit côté agent Notifuse (ticket déposé) | 🟡 P1 | ⏳ Ticket `veridian-notifuse/todo/2026-05-24-audit-trial-residus-notifuse.md` |
| Downstream Prospection — caps + welcome leads | Hors scope Hub : audit côté agent Prospection (ticket déposé) | 🟡 P1 | ⏳ Ticket `veridian-prospection/todo/2026-05-24-audit-trial-residus-prospection.md` |
| Drift detection cron trial vs sub | Pas encore câblé (mentionné ticket §D) | 🟡 P2 | ⏳ Ticket `todo/2026-05-24-drift-detection-trial-vs-sub.md` |

**Résultat global** : promesse Robert tenue **côté Hub** après les 2 fixes ci-dessus.
Reste 2 audits downstream + 1 drift detection cron à implémenter en suite.

---

## 1. Code Hub touchant au trial — inventaire complet

### 1.1 Lectures/écritures de `tenant_trials`

| Fichier | Écriture | Lecture | Comportement post-paiement |
|---|---|---|---|
| `lib/webhooks/notifuse-handlers.ts:158` | upsert `eligible` sur `tenant.activity_threshold_reached` | — | Idempotent — replay safe |
| `lib/trial/run-tick.ts:236` (phase activate) | `state='trial_active'` après 48h eligible | scan `state='eligible'` | OK : si sub déjà active, purge a déjà tourné via Stripe webhook |
| `lib/trial/run-tick.ts:323` (phase notify) | `endingSoonNotified=true` ou ➜ `converted` (FIX) | scan `state='trial_active'` ≥12j | **FIX** : skip + auto-purge si sub active |
| `lib/trial/run-tick.ts:419` (phase finalize) | `state='converted'` si sub OU `state='expired'` sinon | scan `state='trial_active'` & `trial_ends_at<=NOW` | OK déjà |
| `app/api/cron/cleanup-trials/route.ts` | hard delete rows `expired` > 90j | — | OK (n'affecte que les expirés vieux) |
| `app/api/admin/tenants/[id]/plan/route.ts` | — | — | n/a (route admin pour grant manuel) |
| `app/dashboard/layout.tsx:31` | — | findMany pour bandeau | OK gated `hasActiveSubscription` |
| `lib/billing/billing-state.ts:267` | — | findUnique `(tenantId, app)` pour endpoint POLL | OK : `stripe_subscription_id` prime sur `trialState` dans `mapPlanSource` |
| `utils/stripe/prisma-sync.ts` (FIX) | `tenantTrial.updateMany` → `converted` | — | **FIX** : purge à chaque sub active |

### 1.2 Composants UI qui mentionnent "trial" / "essai"

```
components/dashboard/FreemiumBanner.tsx       # OK : prop phase, gated par layout
app/dashboard/layout.tsx                       # OK : layer hasActiveSubscription
app/dashboard/billing/SubscriptionCard.tsx     # OK : status='trialing' Stripe natif
app/dashboard/billing/BillingStatusAlert.tsx   # OK : rend null pour active/trialing
app/dashboard/billing/page.tsx                 # OK : utilise SubscriptionCard
app/dashboard/admin/page.tsx                   # OK : page admin interne
app/dashboard/admin/tenants/page.tsx           # OK : page admin interne
app/(marketing)/pricing/page.tsx               # OK : page marketing, pas dashboard
```

Aucun composant dashboard n'affiche de timer ou de message "essai" en
dehors du `FreemiumBanner` gated par `hasActiveSubscription`. **Aucun
résidu UI à corriger côté Hub.**

### 1.3 Emails trial — qui envoie quoi

| Template | Source code | Trigger |
|---|---|---|
| `buildTrialStartedEmail` | `lib/email/templates/trial.ts` | `processActivations` (cron, phase 1) |
| `buildTrialEndingSoonEmail` | `lib/email/templates/trial.ts` | `processEndingSoon` (cron, phase 2) — **FIX skip si sub active** |
| `buildTrialExpiredEmail` | `lib/email/templates/trial.ts` | `processFinalize` (cron, phase 3, sans sub) |

Mails de marketing/onboarding 5×J0 → J+15 hors scope (envoyés par
Notifuse côté segmentation user, pas par le cron trial). À auditer côté
Notifuse.

---

## 2. Faille principale identifiée + fix

### Avant fix

**Scénario reproductible** :

1. User signup → tenant créé
2. Notifuse envoie `tenant.activity_threshold_reached` → upsert `tenant_trials state='eligible'`
3. +48h cron tick → `state='trial_active'`, `trial_ends_at = NOW + 15j`
4. **J+5** : user paie via Stripe Checkout → `customer.subscription.created`
5. `manageSubscriptionStatusChange` :
   - ✅ Persiste `subscriptions` row `status='active'`
   - ✅ Update `tenants.notifusePlan='pro'`
   - ❌ **NE TOUCHE PAS `tenant_trials`** — `state` reste = `'trial_active'`
6. **J+12** : cron `processEndingSoon` scan → trouve la row du user payeur
   - ❌ Envoie le mail `buildTrialEndingSoonEmail` "ton essai expire dans 3j"
   - ❌ Pose `endingSoonNotified=true`
7. **J+15** : cron `processFinalize` → trouve `hasActiveSub=true` → bascule `converted` (le mal est fait, le mail a déjà été envoyé en J+12)

**Conséquences** :
- Promesse Robert violée : le user qui paie reçoit un mail "expire dans 3j"
- Confusion + risque churn ("j'ai payé mais on me dit que mon essai finit")
- Drift visible si cron drift detection regarde `tenant_trials.state vs subscriptions.status`

### Après fix

#### Fix 1 — `utils/stripe/prisma-sync.ts` (purge proactive)

Au step 5 ci-dessus, après le `tenant.update`, on ajoute :

```ts
if (isActive) {
  const converted = await prisma.tenantTrial.updateMany({
    where: {
      tenantId: tenant.id,
      state: { in: ['eligible', 'trial_active', 'trial_ending_soon'] },
    },
    data: { state: 'converted', updatedAt: new Date() },
  });
}
```

**Idempotent** : si la row est déjà `converted`/`expired`, WHERE exclut.
**Non-bloquant** : try/catch — un échec DB n'empêche pas la propagation
downstream. Le pire scénario reste rattrapable par `processFinalize`.

#### Fix 2 — `lib/trial/run-tick.ts` (défense en profondeur)

`processEndingSoon` batch-resolve les subs Stripe actives et :
- skip l'email si `hasSub=true`
- auto-corrige la row à `converted` (rattrape les rows qui auraient
  échappé au fix 1 — webhook KO, ENV manquante, etc.)

### Tests anti-régression (Nuclear)

- `__tests__/utils/stripe/prisma-sync.test.ts` : 4 nouveaux tests
  - sub active → purge appelée avec bon filtre
  - sub canceled → pas de purge
  - sub trialing → purge OK
  - purge KO → non-bloquant (propagation continue)
- `__tests__/lib/trial/run-tick.test.ts` : 1 nouveau test
  - phase notify + hasSub=true → 0 mail + row → converted + `endingSoonNotified` non écrit

**1636/1636 tests verts** après fixes.

---

## 3. Périmètre downstream (hors scope code Hub)

### 3.1 Notifuse

Le Hub a déjà tout ce qu'il faut côté webhook Stripe :
- Update `tenants.notifusePlan` en DB Hub (source de vérité)
- HMAC propagation `client.updatePlan({tenantId, plan})` vers Notifuse

**À auditer côté Notifuse** (ticket déposé) :
- `veridian_plan` row : reçoit bien `plan='pro'` et purge tout `activity_threshold_reached_at` / timer trial interne
- Templates marketing trial : skipper les users `veridian_plan='pro'`
- Bandeau "essai gratuit" du dashboard Notifuse : disparaît
- Aucun cron Notifuse ne continue à compter pour ce user

### 3.2 Prospection

**À auditer côté Prospection** (ticket déposé) :
- Caps freemium (100 prospects welcome) levés au passage paid
- Compteur "98/100" qui s'arrête → "illimité" / pas d'affichage
- Middleware Prospection lit plan COURANT, pas cache stale d'avant conversion
- Welcome leads upgrade : déjà géré par Hub via
  `grantWelcomeLeadsBestEffort` dans `prisma-sync.ts:318` (delta sur
  upgrade Prospection) — à confirmer côté Prospection que `credit-leads`
  accepte bien la requête sur tenant en upgrade

### 3.3 Drift detection (ticket §D) — ✅ livré 2026-05-25

Cron quotidien `hub-trial-drift-cron.yml` (07:00 UTC) qui cross-check
`tenant_trials.state` vs Stripe subscriptions et catégorise les drifts :

- **medium** : `trial_active` + Stripe `active` (purge ratée — user paie mais
  Hub le considère encore en essai)
- **high**   : `expired` + Stripe `active` (downgrade auto fait alors que user
  paie → impact business immédiat)
- **low**    : `converted` + Stripe `canceled`/`incomplete`/`none` (Hub croit
  que le user paie mais Stripe dit non)

Mode **report-only** v1 (P0 lock côté code, miroir de `runReconcile`). Pas
d'auto-fix tant qu'on n'a pas observé en réel + validé que les drifts
détectés sont bien des bugs. Pas de Telegram non plus — le workflow
GH Actions exit 1 si drifts > 0, ce qui suffit à faire apparaître le run en
rouge dans l'onglet Actions (Robert surveille déjà).

Implémentation :
- `lib/trial/drift-detection.ts` — runner testable
- `app/api/cron/trial-drift-detection/route.ts` — thin wrapper auth Bearer
- `.github/workflows/hub-trial-drift-cron.yml` — cron daily 07:00 UTC
- `__tests__/lib/trial/drift-detection.test.ts` + route test (Nuclear)

---

## 4. Définition of Done (état au 2026-05-24)

| Item | État |
|---|---|
| Audit Hub livré, gaps identifiés | ✅ |
| Fix `prisma-sync.ts` purge → converted | ✅ |
| Fix `processEndingSoon` skip sub active + auto-purge | ✅ |
| Tests anti-régression (5 nouveaux) | ✅ |
| Vitest 1636/1636 vert | ✅ |
| Spec E2E `e2e/staging-full/` | ✅ `09-trial-residus-after-paid.spec.ts` |
| Runbook support | ✅ `runbooks/services/hub/trial-residus.md` |
| Tickets downstream Notifuse + Prospection | ✅ déposés |
| Ticket drift detection | ✅ déposé |
| Push staging | ⏳ après ce push |

---

## 5. Références

- Ticket : `todo/2026-05-23-audit-trial-residus-apres-paiement.md`
- Pricing source de vérité : `docs/PRICING-VERIDIAN.md`
- Trial state machine : `lib/trial/run-tick.ts` + `lib/trial/transitions.ts`
- Stripe webhook orchestrator : `lib/stripe/dispatcher.ts` + `utils/stripe/prisma-sync.ts`
- Banner UI : `lib/trial/banner-state.ts` + `components/dashboard/FreemiumBanner.tsx`
- Endpoint POLL apps : `lib/billing/billing-state.ts`
