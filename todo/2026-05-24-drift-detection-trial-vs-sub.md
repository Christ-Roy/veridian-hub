# [HUB] Drift detection cron — incohérences `tenant_trials` vs `subscriptions`

> **Sévérité** : 🟡 P2 — observabilité, garde-fou pour les 2 fixes anti-résidus livrés
> **Owner** : agent Hub
> **Créé** : 2026-05-24
> **Demandeur** : agent Hub (suite audit trial)
> **Référence** : `docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md` §3.3 + ticket
>   `todo/2026-05-23-audit-trial-residus-apres-paiement.md` §D

---

## Pourquoi

Depuis 2026-05-24, on a 2 garde-fous code pour purger
`tenant_trials → converted` quand une sub Stripe devient active :

1. **Proactif** : `utils/stripe/prisma-sync.ts` §1ter au webhook
2. **Défensif** : `lib/trial/run-tick.ts:processEndingSoon` skip + purge

Ces garde-fous couvrent 99% des cas mais peuvent rater si :
- Le webhook Stripe ne tombe jamais (signature KO, IP allowlist, etc.)
- Une row `tenant_trials` arrive PLUS TARD que la sub (ex: replay
  `tenant.activity_threshold_reached` après que le user ait déjà payé)
- DB temporairement KO au moment du webhook (purge non-bloquante → skip)

Il faut un **filet humain** : un cron quotidien qui détecte les
incohérences (subscription active ET tenant_trials.state non-terminal)
et alerte Telegram + lance une auto-correction.

---

## Spec du cron

### Endpoint

`POST /api/cron/drift-trial-vs-sub` — Bearer `CRON_SECRET`.

### Schedule

Quotidien à 4h UTC (`.github/workflows/hub-drift-trial-vs-sub.yml`).
Idéalement après le cron `trial-tick` et le cron `reconcile-tenants`.

### Logique

```sql
-- Tenants en drift :
-- subscription.status IN ('active', 'trialing')
-- ET tenant_trials.state IN ('eligible', 'trial_active', 'trial_ending_soon')
SELECT tt.tenant_id, tt.app, tt.state, s.status AS sub_status, s.id AS sub_id
FROM hub_app.tenant_trials tt
JOIN hub_app.tenants t ON (
  t.id::text = tt.tenant_id
  OR t.notifuse_workspace_slug = tt.tenant_id
  OR t.slug = tt.tenant_id
)
JOIN hub_app.subscriptions s ON s.user_id = t.user_id
WHERE tt.state IN ('eligible', 'trial_active', 'trial_ending_soon')
  AND s.status IN ('active', 'trialing')
  AND t.deleted_at IS NULL;
```

Pour chaque drift trouvé :

1. **Log** structuré (Grafana Loki) : `[cron-drift-trial] tenant=X app=Y state=trial_active sub=active`
2. **Auto-corrige** : `UPDATE tenant_trials SET state='converted', updated_at=NOW() WHERE ...`
3. **Compteur** dans summary : `drifts_detected`, `drifts_corrected`

### Alerting Telegram

À la fin du run :
- Si `drifts_detected = 0` → silencieux (rien)
- Si `drifts_detected > 0` → alerte Telegram avec sample des 10 premiers
  (`<b>Drift trial vs sub détecté</b>\n N rows corrigées automatiquement.`)

### Idempotent

Run 2× le même jour = même résultat (les rows déjà corrigées sont passées
à `converted` au premier run, donc plus dans le scan au second).

---

## Implémentation suggérée

Pattern miroir de `lib/trial/run-tick.ts` :

```
app/api/cron/drift-trial-vs-sub/route.ts  ← thin wrapper auth Bearer
lib/trial/drift-detection.ts              ← runDriftDetection() testable
__tests__/lib/trial/drift-detection.test.ts
.github/workflows/hub-drift-trial-vs-sub.yml
```

Tests nuclear obligatoires :
- 0 drift → no-op silencieux
- N drifts → tous corrigés, alerte Telegram envoyée
- Auto-correction idempotente (run 2× → seul le premier corrige)

---

## DoD

- [ ] Endpoint `/api/cron/drift-trial-vs-sub` créé + auth Bearer
- [ ] `lib/trial/drift-detection.ts` + tests Nuclear
- [ ] Workflow GH Actions cron quotidien 4h UTC
- [ ] Alerte Telegram câblée (réutiliser `sendTelegramAlert`)
- [ ] Doc dans `docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md` §3.3 → cochée
- [ ] Push staging puis main (tier 🟡)
