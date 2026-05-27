# Hub billing & quota CRM Veridian — impl backend

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Bloqué par** : `2026-05-27-review-offre-crm-veridian.md` (les 7 décisions Robert doivent être prises)
> **Compagnon UI** : `2026-05-27-pricing-page-update-crm.md`

## TL;DR

Le Hub Stripe orchestre le billing CRM Veridian. **Pas de
`IS_BILLING_ENABLED=true` côté Twenty** (77% du module billing Twenty
est `@license Enterprise`, intouchable). Le Hub gère :

1. Souscription Stripe Veridian (Free / Pro / Business / Enterprise)
2. Quota IA mensuel par tenant CRM (compteur côté Hub, check avant
   chaque call AI Twenty via guard custom)
3. Coupons Stripe pour démos clients consulting
4. Achat one-shot de tokens IA supplémentaires (si décision Q2 = option c)
5. Lifecycle tenant (suspend si paywall, resume si paiement)

## Dépendances strictes

- ⛔ **NE PAS commencer** tant que `2026-05-27-review-offre-crm-veridian.md` n'a pas ses 7 réponses gravées par Robert
- ⛔ **NE PAS toucher** au code Twenty CRM (modifs CRM = autre ticket dans veridian-crm-repo)
- ✅ Compatible avec route `POST /api/admin/crm/create-tenant` du ticket `2026-05-27-route-admin-create-crm-tenant.md` (qui sera étendue ici avec un champ `plan`)

## État technique actuel (rappels critiques)

### Côté Twenty CRM (staging)

- Déployé sur `https://crm.staging.veridian.site`
- `IS_BILLING_ENABLED=false` → tout illimité côté Twenty
- `BillingUsageService.hasAvailableCreditsOrThrow()` retourne `true` toujours dans cet état (cf code line 252+)
- Clé API IA = `ANTHROPIC_API_KEY` server-wide (à poser ENV — pas par workspace nativement)

### Côté Hub

- Stripe Veridian déjà câblé (subscriptions Notifuse/Prospection actifs)
- Schéma Prisma a déjà `Tenant` model (Notifuse/Prospection) — on garde une table dédiée `crm_tenants` (cf ticket create-tenant)
- Webhook Stripe Hub déjà actif (`/api/webhooks/stripe` orchestrator)
- Flow trial cross-app éprouvé sprint v1.4 (5 mails → 2j → 15j → downgrade)

## Tâches

### T1. Étendre la table `crm_tenants` avec colonnes billing

Migration Prisma additionnelle (sur la table créée par le ticket
create-tenant, ne pas refaire la table from scratch) :

```sql
ALTER TABLE hub_app.crm_tenants
  ADD COLUMN plan TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN trial_ends_at TIMESTAMPTZ,
  ADD COLUMN ai_tokens_quota_monthly INTEGER NOT NULL DEFAULT 100000,
  ADD COLUMN ai_tokens_used_this_period INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN ai_tokens_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN ai_extra_tokens_purchased INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN stripe_customer_id TEXT;

CREATE INDEX idx_crm_tenants_plan ON hub_app.crm_tenants(plan);
CREATE INDEX idx_crm_tenants_stripe_sub ON hub_app.crm_tenants(stripe_subscription_id);
```

Valeurs `ai_tokens_quota_monthly` selon décision Q2 (proposition initiale) :
- `free` → 100 000
- `pro` → 1 500 000
- `business` → 10 000 000
- `enterprise` → `Number.MAX_SAFE_INTEGER` (illimité)

### T2. Module `veridian-hub/lib/crm/billing.ts`

Helpers :
- `getCrmTenantPlan(workspaceId)` → `'free' | 'pro' | 'business' | 'enterprise'`
- `checkAiQuota(workspaceId)` → `{ allowed: bool, remaining: number, resetAt: Date }`
- `incrementAiUsage(workspaceId, tokensIn, tokensOut, modelId)` → débite + persist
- `resetAiUsageIfNewPeriod(workspaceId)` → cron-friendly, reset si on a passé `ai_tokens_period_start + 30j`
- `purchaseExtraTokens(workspaceId, packKey)` → crée Checkout Stripe one-shot, sur webhook `checkout.completed` ajoute à `ai_extra_tokens_purchased`

### T3. Route proxy IA `/api/crm-ai-proxy/[provider]/[...path]`

⚠️ **C'est le coeur** : tous les calls AI Twenty passent par cette
route Hub avant d'atteindre Anthropic/OpenAI.

Pourquoi : Twenty ne supporte pas le quota par workspace nativement
(cf analyse `provider-config.service.ts` server-wide). Donc on intercepte.

Flow :

```
Twenty CRM tenant X chat-agent
  → call POST https://api.anthropic.com/v1/messages (avec clé Veridian)
  → MAIS Twenty est configuré pour appeler https://hub.veridian.site/api/crm-ai-proxy/anthropic/v1/messages à la place
  → Hub check quota workspace X
  → Si OK : forward vers Anthropic avec vraie clé, return stream
  → Si dépassé : return 429 + body { error: "quota_exhausted", upgradeUrl: "..." }
  → Après forward : count tokens dans la response, incrementAiUsage
```

**Comment Twenty appelle Hub au lieu d'Anthropic direct** : via le
système `AI_PROVIDERS` JSON env de Twenty qui permet de définir
`baseUrl` custom par provider. Côté compose Twenty CRM staging :

```yaml
AI_PROVIDERS: |
  {
    "anthropic": {
      "npm": "@ai-sdk/anthropic",
      "label": "Anthropic via Veridian",
      "apiKey": "{{ANTHROPIC_API_KEY}}",
      "baseUrl": "https://hub.staging.veridian.site/api/crm-ai-proxy/anthropic"
    },
    "openai": {
      "npm": "@ai-sdk/openai",
      "label": "OpenAI via Veridian",
      "apiKey": "{{OPENAI_API_KEY}}",
      "baseUrl": "https://hub.staging.veridian.site/api/crm-ai-proxy/openai"
    }
  }
```

⚠️ La clé Anthropic réelle reste **côté Hub seulement** — côté Twenty
on met une clé "Veridian-internal-token" qui sert juste à
authentifier que c'est bien un Twenty Veridian qui parle au Hub
(HMAC signature dans le header).

**Validation** : ce pattern est natif via la doc Twenty AI providers
(baseUrl override). À tester en staging avant push prod.

### T4. Cron Hub `/api/cron/crm-reset-monthly-quota`

Tourne une fois par heure. Pour chaque tenant CRM où
`NOW() >= ai_tokens_period_start + 30 days` :
- `ai_tokens_used_this_period = 0`
- `ai_tokens_period_start = NOW()`
- `ai_extra_tokens_purchased = 0` (les achats one-shot s'épuisent au cycle)

### T5. Étendre route `POST /api/admin/crm/create-tenant`

Body étendu :
```json
{
  "email": "client@example.com",
  "workspaceName": "Acme Corp",
  "plan": "pro"  // optionnel, défaut "free"
}
```

Logique :
- Si `plan: 'free'` → `trial_ends_at = NOW() + 15 jours`, pas de Stripe
- Si `plan: 'pro' | 'business' | 'enterprise'` → créer Customer Stripe + Subscription Stripe (réutiliser le flow Notifuse/Prospection existant)
- Si `couponCode` fourni : appliquer le coupon à la Subscription Stripe
- Quota IA selon plan (T1 valeurs)

### T6. Coupons Stripe — pattern admin

Pas de UI admin Hub pour la vague 3 (Robert crée à la main dans
dashboard Stripe). Documenter dans `docs/CRM-INTEGRATION.md` :

```
1. Aller dashboard.stripe.com → Coupons → Create
2. ID coupon (ex: DEMO_CONSULTING_3M)
3. Discount: 100% off, duration: repeating 3 months
4. Restrictions: applies to Veridian CRM Business price
5. Communiquer le code coupon au client
6. Client passe par checkout https://app.veridian.site/upgrade?plan=business&coupon=DEMO_CONSULTING_3M
```

Le checkout Hub doit accepter le param `coupon` et le forwarder à
Stripe Checkout (`discounts: [{ coupon: <id> }]`).

### T7. Suspend / resume tenant CRM sur événement Stripe

Hook Stripe webhook orchestrator Hub :
- `subscription.deleted` ou `subscription.past_due` →
  `POST /api/admin/crm/tenants/{id}/suspend` (à créer côté CRM mais
  PAS via contrat Hub strict — juste un soft block côté tenant)
- `subscription.updated` (resumed) → idem `/resume`

**Pour la vague 3** : on peut se contenter de bloquer le magic link
(Hub refuse de générer un magic link pour un tenant `status=suspended`).
Twenty CRM reste actif, mais l'user ne peut plus se logger. Pas de
purge data, pas de hard delete.

### T8. Tests E2E

```bash
# 1. Create freemium tenant
curl -X POST $HUB/api/admin/crm/create-tenant -d '{"email":"free@test.fr","workspaceName":"Free Test"}'
# → trial_ends_at = J+15, quota AI 100k

# 2. Bump plan via Stripe (simul webhook)
# Use Stripe CLI : stripe trigger customer.subscription.updated
# → plan="pro", quota AI 1.5M

# 3. Test quota AI hit
# Avec le Bearer du tenant, faire 1500 calls /rest/ai/generate
# → 1499 OK, 1500e → 429 quota_exhausted

# 4. Achat extra tokens
curl -X POST $HUB/api/crm/extra-tokens/purchase -d '{"packKey":"5M_extra"}'
# → Checkout Stripe → webhook → ai_extra_tokens_purchased += 5_000_000

# 5. Coupon démo
# Create coupon ROBERT_OFFERT en dashboard Stripe
curl -X POST $HUB/api/checkout/crm -d '{"plan":"business","coupon":"ROBERT_OFFERT"}'
# → Checkout 100% off, subscription active sans CB facturée

# 6. Suspend
stripe trigger customer.subscription.deleted
# → tenant status="suspended", magic link route 403
```

## Décisions à confirmer avant impl

Tous ces points sont dans le ticket review compagnon. Réponses
attendues Robert :

- [ ] Plans → noms exacts (Free / Pro / Business / Enterprise selon Q1)
- [ ] Prix exacts CRM (29€/99€ ou différent)
- [ ] Quotas IA par plan (Q2)
- [ ] Hard cap vs pay-as-you-go vs pack one-shot (Q2)
- [ ] Coupons attendus (Q3 noms exacts)
- [ ] CRM standalone ou inclus bundle (Q1)

## Non-objectifs

- ❌ Activer `IS_BILLING_ENABLED=true` côté Twenty (interdit légalement
  — module EE)
- ❌ Implémenter les Stripe metered prices natifs Twenty (idem)
- ❌ UI admin Hub pour gérer coupons (vague 4+)
- ❌ Rebrand CRM (vague 4)
- ❌ Page pricing publique (ticket compagnon `pricing-page-update-crm.md`)
