# Audit cross-app state — Notifuse + Prospection vs CONTRAT-HUB v1.5 + PRICING v1.1

> **Type** : Rapport d'audit lecture-seule
> **Sévérité** : 🟢 P2 doc only
> **Owner** : agent Hub (audit) → routes vers Notifuse / Prospection
> **Créé** : 2026-05-21
> **Marker promo** : `[risk:low]`
> **Scope** : état réel des 2 apps downstream à fin 2026-05-21, snapshot de
> ce qui est livré / partiel / pas commencé vs CONTRAT-HUB v1.5 (gravé
> aujourd'hui par l'agent Hub) et PRICING-VERIDIAN v1.1.

---

## TL;DR

| Dimension | Notifuse | Prospection |
|---|---|---|
| `attach-member` endpoint | ✅ Livré (service + handler + tests) | ✅ Livré (route §5.22 v1.5 conforme) |
| Discovery `users/by-email` | ✅ Livré (POST, HMAC) | ✅ Livré (GET, HMAC) |
| `hub_user_id` column + `resolveOrCreateUserFromHub` | N/A (workspace-centric, pas user-centric) | ✅ Livré (e216d3c, helper §3.7) |
| Trial signal `tenant.activity_threshold_reached` | ✅ Code émetteur câblé (5 mails idempotent + webhook) | ⏳ N/A (pas de seuil métier équivalent à ce jour) |
| Paywall degraded mode (soft-delete UX) | ✅ Livré (Lot J — middleware obfuscation 33% + 402 standardisé) | ⏳ Pas commencé (mur béton 402 actuel — pas de ticket) |
| Pricing aligné v1.1 | ✅ Pro 29€ / Business 99€ / illimité (sauf white-label) | ✅ Freemium 100 / Pro 29€/2000 / Business 89€/8000 (via @veridian/shared submodule) |
| Consomme `GET /api/pricing/plans` Hub | ❌ Pas encore (ticket pending `2026-05-21-consume-hub-pricing-api.md`) | ✅ Submodule `@veridian/shared` (source canonique compile-time, fait l'affaire) |
| Refill leads one-shot Stripe Checkout | N/A | ❌ **TROU MAJEUR** — `src/app/api/checkout/route.ts` legacy "geo/full" plans, pas de route refill |
| Welcome leads grant à la souscription | N/A | 🟡 Champ `welcomeLeads` exposé dans `plans.ts`, **aucun call-site** qui le crédite à la souscription (grep src/ vide) |
| Secrets HMAC `HUB_API_SECRET` | ✅ Câblé (`config.HubAPISecret`) | ✅ Câblé (`lib/hub/auth.ts`) |
| Bearer webhook `HUB_WEBHOOK_TOKEN` (sens app→Hub) | ✅ `HUB_WEBHOOK_SECRET` HMAC (webhook_emitter.go) | ✅ `HUB_WEBHOOK_TOKEN` Bearer (lib/hub/webhooks.ts pattern C §6.3) |

---

## 1. État Notifuse — détail

### Branche `veridian` (snapshot HEAD 685b3ffc)

Working tree non propre (en travail actif sur **rotate-transfer endpoints**
+ migration V41 + API key grace repo — Lot K en cours). Le contexte des
modifs non-committées est cohérent avec le ticket
`todo/2026-05-19-rotate-transfer-owner-endpoints.md` (§5.15 v1.5).

### Livré ✅

1. **attach-member endpoint** (`internal/http/veridian_attach_member_handler.go` + test, `internal/service/veridian_service.go:1710+ AttachMember`). Ticket archivé `todo/done/2026-05-21-hub-attach-member-endpoint.md`. Spec conforme §5.22 contrat v1.5.
2. **Discovery `POST /api/users/by-email`** (`internal/http/veridian_discovery_handler.go`). POST (pas GET pour éviter logging URL), HMAC standard, 200 found/not-found. Ticket archivé `done/2026-05-20-add-discovery-endpoint-by-email.md`.
3. **Trial signal `tenant.activity_threshold_reached`** :
   - Colonne V38 `activity_threshold_reached_at` (TIMESTAMP WITH TIME ZONE)
   - `MarkActivityThresholdReached` SQL idempotent (`SET WHERE IS NULL`)
   - Emit dans `IncrementEmailsSent` quand `emails_sent_lifetime` franchit 5
   - WebhookEmitter HMAC vers Hub (`internal/service/veridian_webhook_emitter.go`, header `X-Veridian-Notifuse-Signature`, retry 3x best-effort)
   - Ticket archivé `done/2026-05-21-trial-eligible-signal.md`
4. **Paywall degraded mode soft-deleted (Lot J)** :
   - `veridian_paywall_softdeleted.go` middleware global avec exempt paths (`/api/veridian/*`, `/api/tenants/*`, `/api/health`, `/api/version`, `/api/auth/*`)
   - `veridian_paywall_obfuscation.go` obfusque 33% des string values sur GET, 100% sur champs sensibles (password, api_key, billing, stripe_*)
   - Écriture (POST/PUT/PATCH/DELETE) → 402 standardisé `{error: tenant_soft_deleted, restore_url, deleted_at, purge_eligible_at}`
   - Commit `685b3ffc feat(lot-i+j)`
5. **Pricing v1.1 conforme** dans `internal/domain/veridian.go` :
   - PIVOT 2026-05-21 documenté : Free / Pro / Business / Enterprise tous illimités (BYO sending)
   - Seul différenciant Business vs Pro = `FeatureWhiteLabel: true`
   - Comment explicite "L'app ne doit JAMAIS etre defiguree par des limites visibles"

### Pending ⏳

1. **Consommer `GET /api/pricing/plans` Hub** : ticket `todo/2026-05-21-consume-hub-pricing-api.md` ouvert (P2). Notifuse est en Go, ne peut pas importer le submodule `@veridian/shared` (TypeScript). Doit fetch le Hub avec cache 1h. Pas encore implémenté — **pas critique** car les valeurs Pro/Business hardcodées dans `DefaultPlanLimits` sont byte-identiques aux canoniques.
2. **rotate-transfer endpoints** (Lot K, §5.15 v1.5) : en cours dans working tree, pas encore committé. Cf. fichiers `?? internal/http/veridian_rotate_transfer_handler.go` etc.

### Pas commencé / non applicable

- ❌ Pas applicable : `hub_user_id` column. Notifuse est workspace-centric (`workspace_id` = source d'identité tenant), pas user-centric. Le mapping user se fait via le owner_email + magic link.

---

## 2. État Prospection — détail

### Branche `staging` (snapshot HEAD ef1ce62)

Working tree non propre (E2E specs cross-app + sprint Telnyx en cours, pas
sur scope cross-app contrat).

### Livré ✅

1. **`hub_user_id` column + `resolveOrCreateUserFromHub`** : commit
   `e216d3c` mentionné dans `todo/done/2026-05-21-add-hub-user-id-column.md`.
   Helper `src/lib/hub/identity.ts:resolveOrCreateUserFromHub({hubUserId, email})`
   utilisé dans `tenants/provision` ET `veridian/workspaces/[id]/attach-member`.
2. **attach-member endpoint** (`src/app/api/veridian/workspaces/[workspaceId]/attach-member/route.ts`)
   conforme §5.22 v1.5 : Zod schema, HMAC requireHubHmac, audit log, magic
   link 24h TTL, role enum. Ticket archivé `done/2026-05-21-hub-attach-member-endpoint.md`.
3. **Discovery `GET /api/users/by-email`** (`src/app/api/users/by-email/route.ts`)
   HMAC §6.1 + legacy bearer fallback (`ACCEPT_LEGACY_BEARER`). Conforme spec.
4. **Pricing v1.1 conforme via submodule `@veridian/shared`** :
   - `src/lib/billing/plans.ts` re-shape depuis `CANONICAL_PLANS["prospection-free|pro|business"]`
   - Freemium welcome_leads=100, Pro 29€ welcome_leads=2000, Business 89€ welcome_leads=8000 ✅
   - `LEAD_REFILL_PRICING_CENTS` (refill dégressif) importé
   - `extractFeatureFlags()` mappe `FeatureKey` (shared) ↔ `FeatureFlag` (local DB)
5. **HMAC Hub + Bearer webhooks** : `HUB_API_SECRET` côté inbound, `HUB_WEBHOOK_TOKEN` côté outbound (lib/hub/webhooks.ts), `tenant.member_role_changed` event câblé (§5.18.4).

### Partiel 🟡 / Trous ❌

1. **❌ Refill leads endpoint manquant** : `src/app/api/checkout/route.ts`
   est en **état legacy** — plans hardcodés `geo` / `full` (placeholders),
   pas de route `/api/refill-leads` ou équivalent qui crée une Stripe
   Checkout one-shot avec quantité de leads. La logique de pricing dégressif
   est dans `plans.ts:LEAD_REFILL_PRICING` mais **aucun call-site** ne
   l'utilise. **C'est un trou business majeur** : le flux "achat de leads
   à la commande" (FLUX 2 du commentaire dans plans.ts) n'a aucune
   route HTTP qui le sert.
2. **🟡 Welcome leads grant à la souscription** : le champ `welcomeLeads:
   number` est défini dans `PlanDefinition` mais `grep -rn "welcomeLeads"
   src/` (hors `plans.ts` et tests) renvoie **0 résultat**. Conséquence :
   au moment où le Hub appelle `UpdatePlan` (free → pro), Prospection ne
   crédite **pas** les 2000 leads promis. C'est un trou de spec (côté
   Prospection ou Hub : qui doit déclencher le grant ? Probable Prospection
   au `update-plan` callback).
3. **🟡 Paywall degraded mode soft-deleted** : pas de middleware équivalent
   au Lot J Notifuse. Quand le Hub soft-delete un tenant Prospection,
   le user voit probablement un mur béton 402 ou un état non géré. Pas de
   ticket pending sur ce sujet.

### Pending dans backlog (sprint v1.5)

- `2026-05-21-sprint-v15-cross-app.md` : sprint orchestrateur — tickets 1
  et 2 livrés (hub_user_id, attach-member). Reste tickets 3 (multi-membre
  §5.18-21) et 4 (smoke prod cross-app + coupure legacy `ACCEPT_LEGACY_HMAC=0`).
- `2026-05-19-v13-multi-membre-cross-app.md` : multi-membre seats (Pro 5
  seats, Business 25 seats — limites pricing v1.1 à enforcer).
- `2026-05-21-business-plan-pricing-features.md` : doc business vivant
  (positionnement, différenciation INPI vs Apollo/Lusha) — pas du dev.

---

## 3. Matrice cross-app — qui bloque qui

```
                   ┌───────────────────────────────────────────┐
                   │ Hub livré côté contrat v1.5 + invitations │
                   │ P1 (étapes 1-3-4a-6 sur main 2026-05-21)  │
                   │ Étape 4b TODO downstream call attendu     │
                   └────────────┬──────────────────────────────┘
                                │
              ┌─────────────────┴───────────────────┐
              ▼                                     ▼
     ┌──────────────────┐                  ┌─────────────────┐
     │ Notifuse (✅)    │                  │ Prospection (✅)│
     │ attach-member    │                  │ attach-member   │
     │ /api/users/by-em │                  │ /api/users/by-em│
     │ trial signal     │                  │ hub_user_id     │
     │ Lot J degraded   │                  │ multi-membre ⏳ │
     │ pricing canon ✅ │                  │ pricing canon ✅│
     └──────────────────┘                  │ refill leads ❌ │
                                           │ welcome grant 🟡│
                                           │ degraded mode ❌│
                                           └─────────────────┘

Flux trial 5 mails → Hub state machine :
  Notifuse emit ✅ ───────► Hub /api/webhooks/notifuse (HMAC) ──► state machine

Flux invitation cross-app v1.5 :
  Hub /api/invitations/[token]/accept ──► appelle attach-member app cible
  Étape 4b Hub à câbler côté Hub (lib/invitations/accept.ts:112 TODO)
  Apps des 2 côtés sont prêtes côté inbound ✅ — c'est le Hub qui doit câbler
  l'outbound HMAC.

Pricing source :
  Hub @veridian/shared (TS) ←── consume submodule ←── Prospection ✅
                            └── expose JSON ────►── Notifuse (Go) ⏳ pas encore consommé
```

### Qui bloque qui

| Bloqueur | Bloqué | Sévérité |
|---|---|---|
| Hub étape 4b invitations (lib/invitations/accept.ts:112) | Flow invitation cross-app bout-en-bout | 🔴 P1 |
| Prospection refill leads route manquante | Revenu FLUX 2 "data à la commande" = 0 | 🔴 P1 business |
| Prospection welcome leads grant non câblé | Conversion Pro perd sa promesse "2000 leads offerts" | 🔴 P1 business |
| Prospection paywall degraded soft-delete | UX churn → mur béton, support submergé (cf. ticket Lot J Notifuse) | 🟡 P2 UX |
| Prospection multi-membre §5.18-21 | Seat pricing Pro 5/Business 25 pas enforcable | 🟡 P2 |
| Notifuse rotate-transfer (Lot K) | Owner transfer Hub-driven §5.15 — bloque dette "qui possède le tenant" | 🟡 P2 |

---

## 4. Top 5 actions urgentes pour débloquer le flow business complet

### 1. 🔴 Câbler étape 4b Hub `lib/invitations/accept.ts` → call attach-member

Les 2 apps downstream ont leur endpoint **prêt et conforme §5.22**.
Le seul truc qui manque pour fermer la boucle invitation cross-app, c'est
le call HMAC côté Hub. Estimation : 30min-1h, agent **Hub**.

### 2. 🔴 Créer route Prospection `POST /api/refill-leads` (Stripe Checkout one-shot)

Sans ça, FLUX 2 = 0 revenu. La grille `LEAD_REFILL_PRICING_CENTS` est dans
le shared, le contexte UI est dans `plans.ts`, mais **aucune route HTTP**
ne crée le Stripe Checkout pour acheter un lot. Estimation : 4-6h, agent
**Prospection**. Doit livrer :
- Route POST avec quantity validation (max `MAX_LEADS_PER_REFILL_ORDER`)
- Calcul prix dégressif depuis `refillTierKey` du tenant.plan actuel
- Stripe Checkout mode `payment` (pas subscription) avec metadata
  `{tenant_id, leads_quantity}`
- Webhook Stripe `checkout.session.completed` qui crédite les leads dans le
  workspace (table `leads` ou colonne `leads_balance`)

### 3. 🔴 Câbler welcome leads grant Prospection à la souscription

Quand le Hub appelle `update-plan(tenant_id=X, plan=pro)`, Prospection doit
créditer `PLANS.pro.welcomeLeads = 2000` au workspace one-shot. Trou de
spec actuel — le champ est défini mais jamais lu. Estimation : 2-3h, agent
**Prospection**. Probable lieu : `app/api/tenants/[tenantId]/update-plan/route.ts`
(s'il existe) ou hook dans le `provision` route.

### 4. 🟡 Notifuse : consommer `GET /api/pricing/plans` Hub (résilience)

Ticket existe (`2026-05-21-consume-hub-pricing-api.md` P2). Pas urgent
fonctionnellement (valeurs byte-identiques), mais utile pour éviter la
dérive silencieuse si la grille pivote encore. Estimation : 2-3h, agent
**Notifuse**.

### 5. 🟡 Prospection : Paywall degraded mode soft-delete (copier Lot J Notifuse)

Copier le pattern Notifuse `veridian_paywall_softdeleted.go` :
- Middleware Express/Next.js qui intercepte les routes app utilisateur
- Exempt paths `/api/veridian/*`, `/api/tenants/*`, `/api/health`, `/api/auth/*`
- GET → obfuscation 33% + champs sensibles (api_key, leads emails) full obfusqués
- Write → 402 standardisé `{error: tenant_soft_deleted, restore_url, ...}`

Estimation : 1 jour, agent **Prospection**. Bloque UX churn → conversion
réactivation.

---

## 5. Tickets à créer (juste lister)

### Côté Hub

- **`veridian-hub/todo/2026-05-21-finir-etape-4b-invitations.md`** —
  câbler l'appel HMAC outbound dans `lib/invitations/accept.ts:112`
  vers les 2 attach-member endpoints (Notifuse + Prospection). Tier 🔴 HAUT.
  Pré-requis : aucun, tout est prêt côté apps.

### Côté Prospection (déposer dans `veridian-prospection/todo/`)

- **`2026-05-22-refill-leads-stripe-checkout-route.md`** — route POST
  `/api/refill-leads` + webhook Stripe `checkout.session.completed`
  qui crédite leads. Tier 🔴 HAUT. **Prio absolue — bloque FLUX 2 revenu.**
- **`2026-05-22-welcome-leads-grant-on-subscription.md`** — câbler
  grant des welcomeLeads dans le flow update-plan / provision. Tier 🔴 HAUT.
- **`2026-05-22-paywall-degraded-mode-soft-deleted.md`** — copier le
  pattern Lot J Notifuse côté Prospection (UX réactivation). Tier 🟡 MOYEN.
- **`2026-05-22-multi-membre-seats-enforcement.md`** — enforcer
  Pro=5 seats / Business=25 seats au moment de l'invite/add-member
  (déjà tracké dans `2026-05-19-v13-multi-membre-cross-app.md` mais
  pas linké au pricing v1.1 explicitement). Tier 🟡 MOYEN.

### Côté Notifuse (déjà existant `2026-05-21-consume-hub-pricing-api.md`)

Pas de nouveau ticket à créer — le pending couvre déjà la consommation
de `GET /api/pricing/plans` Hub.

---

## 6. Cohérence secrets cross-app

| Secret | Sens | Notifuse | Prospection | Statut |
|---|---|---|---|---|
| `HUB_API_SECRET` | Hub→app HMAC (inbound) | `config.HubAPISecret` (`config/config.go:863`) | `process.env.HUB_API_SECRET` (`lib/hub/auth.ts:22`) | ✅ Nom identique |
| `HUB_WEBHOOK_SECRET` | app→Hub HMAC (outbound webhook) — Notifuse | `config.HubWebhookSecret` (`config/config.go:865`) | N/A (Prosp utilise Bearer pas HMAC) | ✅ |
| `HUB_WEBHOOK_TOKEN` | app→Hub Bearer (outbound webhook) — Prosp | N/A | `lib/hub/webhooks.ts:45` | ✅ |
| `HUB_API_URL` | URL Hub pour outbound | `HUB_WEBHOOK_URL` (séparé) | `process.env.HUB_API_URL` | 🟡 Léger drift nom — pas bloquant |

**À vérifier côté Dokploy prod** :

```
POST /api/compose.one?composeId=WN0jglLj5bDIrXUFZHNmw   # Notifuse
POST /api/compose.one?composeId=275o-9E3ZWWi0X32wY8hM   # CMS (pas testé ici)
```

Pour s'assurer que `HUB_API_SECRET` et `HUB_WEBHOOK_SECRET` / `HUB_WEBHOOK_TOKEN`
sont bien dans les ENV des 2 composes prod, et identiques à ceux du Hub
`compose-back-up-online-pixel-nl2k9p`. **Cet audit n'a pas testé runtime**
— il faudrait une vérif Dokploy API séparée. À ajouter au ticket
finir-etape-4b s'il est créé.

---

## 7. Conclusion

Les 2 apps sont **conformes au contrat v1.5 côté inbound HMAC**. Tout ce
qui est demandé par le Hub (attach-member, discovery by-email, hub_user_id
Prospection) est livré et testé. Pricing v1.1 est appliqué correctement
sur les 2 apps (Notifuse via valeurs hardcodées documentées, Prospection
via submodule `@veridian/shared`).

**Les 3 trous business** ne sont **pas des trous contrat** mais des **trous
de monétisation côté Prospection** :

1. Pas de route refill leads → FLUX 2 = 0 revenu
2. Pas de grant welcome leads → promesse marketing non tenue
3. Pas de paywall degraded soft-delete → churn UX dégradé

**Prochaine action recommandée** : router ce rapport vers l'agent
Prospection pour qu'il crée les 4 tickets `2026-05-22-*` et les
priorise dans son backlog. L'agent Hub doit, en parallèle, créer le
ticket finir-étape-4b.
