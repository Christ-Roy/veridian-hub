# [HUB] Circuit breaker + alerting coût IA CRM par tenant

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Audit `/tmp/audit-crm-needs-2026-05-27.md` §D.2 (gap "pas de cap sur le coût brut")
> - Complète `todo/2026-05-27-billing-hub-pour-crm.md` (T2 manque cette dimension)
> - Pattern alerting Telegram : `lib/telegram/` (à vérifier en place) ou skill telnyx

## Contexte

Le quota IA mensuel (`ai_tokens_quota_monthly`) est notre **premier filet**
contre l'abus. Mais il a 2 failles :

1. **Bug Hub-side** : si `incrementAiUsage` plante silencieusement (race
   condition, exception non catch), le quota n'est jamais débité et un
   user freemium peut consommer **illimité** sans bloc.
2. **Burst sur une heure** : un user peut envoyer 1000 calls / minute via
   l'API Twenty `/rest/ai/*` ou via un script attaquant qui aurait leak
   le `CRM_AI_PROXY_SHARED_SECRET`. Le quota mensuel est consommé en 5
   min → Anthropic facturé en €€€.

Le quota seul n'est donc **pas suffisant** pour protéger le budget
Anthropic Veridian. Il faut un **circuit breaker basé sur le coût € réel**
+ une alerte Telegram dès qu'un tenant dépasse un seuil suspect.

## Action attendue

### 1. Calcul du coût € par tenant en temps réel

Étendre `lib/crm/billing.ts` avec :

```typescript
// Tarifs Anthropic publics (à externaliser ENV pour update faciles)
const ANTHROPIC_PRICING_USD_PER_MTOK = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  // fallback générique
  '_default': { input: 5, output: 20 },
} as const;

export function estimateCallCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = ANTHROPIC_PRICING_USD_PER_MTOK[model] ?? ANTHROPIC_PRICING_USD_PER_MTOK._default;
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}
```

### 2. Nouvelles colonnes `crm_tenants`

```sql
ALTER TABLE hub_app.crm_tenants
  ADD COLUMN ai_cost_usd_this_period NUMERIC(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN ai_cost_alert_50_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ai_cost_alert_200_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ai_breaker_tripped_at TIMESTAMPTZ;

CREATE INDEX idx_crm_tenants_breaker ON hub_app.crm_tenants(ai_breaker_tripped_at) WHERE ai_breaker_tripped_at IS NOT NULL;
```

À reset au cron mensuel (en plus de `ai_tokens_used_this_period`).

### 3. Étendre `incrementAiUsage`

Après debit tokens, calculer le coût et :

```typescript
const callCostUsd = estimateCallCostUsd(model, promptTokens, completionTokens);

await prisma.crmTenant.update({
  where: { id: tenantId },
  data: {
    aiTokensUsedThisPeriod: { increment: promptTokens + completionTokens },
    aiCostUsdThisPeriod: { increment: callCostUsd },
  },
});

const tenant = await prisma.crmTenant.findUniqueOrThrow({ where: { id: tenantId } });

// Seuils d'alerte (per tenant per mois)
if (tenant.aiCostUsdThisPeriod >= 50 && !tenant.aiCostAlert50Sent) {
  await alertTelegram(`⚠️ CRM tenant ${tenant.workspaceDisplayName} a dépassé $50 IA ce mois (${tenant.aiCostUsdThisPeriod.toFixed(2)})`);
  await prisma.crmTenant.update({ where: { id: tenantId }, data: { aiCostAlert50Sent: true } });
}
if (tenant.aiCostUsdThisPeriod >= 200 && !tenant.aiCostAlert200Sent) {
  await alertTelegram(`🚨 CRM tenant ${tenant.workspaceDisplayName} a dépassé $200 IA ce mois — circuit breaker armé`);
  await prisma.crmTenant.update({
    where: { id: tenantId },
    data: { aiCostAlert200Sent: true, aiBreakerTrippedAt: new Date() },
  });
}
```

### 4. Circuit breaker dans le proxy AI

Dans `app/api/crm-ai-proxy/[provider]/[...path]/route.ts`, avant
`checkAiQuota` :

```typescript
const tenant = await prisma.crmTenant.findUnique({ where: { twentyWorkspaceId: workspaceId } });
if (tenant?.aiBreakerTrippedAt) {
  return Response.json({
    error: 'ai_circuit_breaker_tripped',
    reason: 'Coût IA mensuel dépassé. Contactez le support.',
    contactUrl: `${HUB_URL}/support`,
  }, { status: 503 });
}
```

Le breaker est **par tenant** et **mensuel** (reset auto par le cron).
Robert peut le re-armer manuellement via :

```sql
UPDATE hub_app.crm_tenants SET ai_breaker_tripped_at = NULL WHERE id = '<uuid>';
```

(ou via une route admin `/api/admin/crm/tenants/[id]/reset-breaker` —
optionnel vague 4).

### 5. Alerting Telegram

Vérifier la présence d'un helper `alertTelegram(msg)` dans
`lib/telegram/` (sinon créer). Token bot + chat ID Robert dans
`~/credentials/.all-creds.env` (à confirmer existant).

Format des alertes :
- $50 → warning : visibilité, pas d'action requise
- $200 → critical : circuit breaker armé, action Robert requise (cf
  `ai_breaker_tripped_at`)
- Bonus : alerte cumulative globale "tous tenants CRM > $1000 mois en cours"
  → daily digest via cron (vague 4)

### 6. Dashboard admin Hub (vue rapide)

Ajouter dans `app/dashboard/admin/page.tsx` un encart :

```
=== CRM AI Cost (this period) ===
Top 5 tenants par coût USD :
1. acme-corp ($142.30, 5.2M tokens)
2. ...
Total cumulé : $XXX / budget mois estimé : $YYY
[Voir détail →]
```

Optionnel vague 3 — peut être un `console.log` cron daily à la place.

### 7. Garde-fous

- **Pas de re-alerte spam** : un seul mail Telegram par seuil par mois
  (flag `ai_cost_alert_*_sent`)
- **Reset au cron mensuel** : à intégrer dans `/api/cron/crm-reset-monthly-quota`
  (alertes flags + cost + breaker tous resets)
- **Pas de breaker pour plan Enterprise** : un check explicite
  `if (tenant.plan === 'enterprise') return;` dans la branche de l'alerte $200
  (les Enterprise négocient le budget hors quota standard)

## Tests / DoD

- [ ] Test unitaire `estimateCallCostUsd` (sonnet/opus/haiku/fallback)
- [ ] Test `incrementAiUsage` :
  - Cumul costUsd correctement incrémenté
  - Alerte $50 envoyée 1 seule fois même si appelé 10x
  - Alerte $200 envoyée + `aiBreakerTrippedAt` set
- [ ] Test proxy AI route :
  - Tenant avec breaker armé → 503 immédiat, pas de forward Anthropic
  - Tenant Enterprise à $300 → pas de breaker (juste alerting silencieux désactivé)
- [ ] Test cron reset :
  - Reset flags + cost + breaker quand `NOW() >= period_start + 30d`
- [ ] Mock `alertTelegram` (pas de spam Telegram pendant CI)
- [ ] Migration Prisma testée (existing tenants : default 0, false, NULL)

## Non-objectifs

- ❌ Pay-as-you-go (acheter +$50 quota au-delà du circuit) — vague 4
- ❌ UI admin pour re-armer breaker (SQL direct OK vague 3)
- ❌ Alerting par email transactionnel (Telegram suffit Robert)
- ❌ Compter le coût OpenAI séparément (vague 4 quand OpenAI activé)
- ❌ Forecast budget mensuel (vague 5+ avec ML)
