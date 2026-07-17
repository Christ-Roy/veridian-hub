# Runbook — "client a payé mais voit toujours une limite trial"

> **Quand utiliser ce runbook** : un client te signale qu'il a payé (Stripe
> Checkout réussi, CB débitée, mail Stripe reçu) MAIS qu'il voit toujours
> un bandeau "essai", reçoit toujours un mail trial, ou que son app affiche
> "freemium" / "expire dans X jours".
>
> **Promesse Veridian** : client paie = plus AUCUNE limite, AUCUN bandeau,
> AUCUN mail trial, partout, immédiatement. Si ce n'est pas le cas, c'est
> un incident à fixer en moins de 10 min.

---

## Diagnostic — l'ordre des vérifications

### 1. Stripe a-t-il vraiment encaissé le paiement ?

Dashboard Stripe ▸ Customers ▸ chercher l'email du client.

- Section "Subscriptions" : doit avoir au moins une sub `Active` ou `Trialing`
- Section "Payments" : doit avoir un paiement `Succeeded` récent

**Si non** : ce n'est pas un bug Hub, le checkout n'est jamais arrivé à
terme (carte refusée silencieusement, abandon, etc.). Le client doit
retenter `/dashboard/billing` → "Ajouter ma carte".

### 2. Le webhook Stripe est-il bien arrivé au Hub ?

Dashboard Stripe ▸ Developers ▸ Webhooks ▸ Endpoint Hub.

Filtrer sur le `customer.subscription.created` (ou `.updated`) du timestamp
du paiement.

- Status doit être `200 OK`
- Si `Failed` ou `Pending` : redéliver manuellement via "Resend"

### 3. Le webhook a-t-il bien été processé côté Hub ?

```bash
# Logs du job Hub (Nomad) — depuis le bastion ou en local
nomad-v logs hub | grep stripe-sync
```

Cherche une ligne du type :
```
[stripe-sync] Tenant <tenant_id> updated: notifuse=pro, prospection=pro
[stripe-sync] Purged N trial row(s) → converted for tenant=<tenant_id> (sub active)
```

**Si la ligne `Purged ... trial row(s) → converted` est absente** alors
qu'une sub est créée → c'est un résidu trial. Continue au §4.

### 4. Inspecter la DB Hub

```bash
# Via le runner Postgres prod
ssh prod-pub 'docker exec -i <hub-db-container> psql -U postgres -d veridian-core' <<'SQL'
-- Trouver le user
SELECT id, email, supabase_user_id, stripe_customer_id
FROM hub_app.users
WHERE email = 'client@example.com';

-- Voir ses subscriptions
SELECT id, status, plan_name, stripe_subscription_id, current_period_end
FROM hub_app.subscriptions
WHERE user_id = '<supabase_user_id>'
ORDER BY created_at DESC LIMIT 5;

-- Voir ses tenants
SELECT id, slug, notifuse_plan, prospection_plan, metadata->>'notifuse_plan_source' as src
FROM hub_app.tenants
WHERE user_id = '<supabase_user_id>' AND deleted_at IS NULL;

-- Voir l'état trial des tenants
SELECT tt.tenant_id, tt.app, tt.state, tt.trial_ends_at, tt.ending_soon_notified, tt.updated_at
FROM hub_app.tenant_trials tt
JOIN hub_app.tenants t ON t.id::text = tt.tenant_id
  OR t.slug = tt.tenant_id
  OR t.notifuse_workspace_slug = tt.tenant_id
WHERE t.user_id = '<supabase_user_id>';
SQL
```

### 5. Lecture du diagnostic

| Cas | Diagnostic | Action |
|---|---|---|
| `subscriptions.status='active'` ET `tenant_trials.state='trial_active'` | Résidu trial — le webhook n'a pas purgé | §6 Fix manuel + investigation cause |
| `subscriptions.status='active'` ET `tenants.notifuse_plan='free'` | Webhook a vu la sub mais pas mis à jour les plans — voir logs `[stripe-sync] tenant.update failed` | Redéliver le webhook + check logs |
| Pas de row `subscriptions` du tout | Webhook jamais arrivé / signature KO | Resend Stripe + check `STRIPE_WEBHOOK_SECRET` ENV |
| `tenants.notifuse_plan='pro'` ET le client voit toujours "free" dans l'UI Notifuse | Drift downstream — pas un bug Hub | Ticket Notifuse + force refresh sub côté Notifuse |

---

## 6. Fix manuel — purge tenant_trials → converted

Si tu tombes sur le cas "sub active + tenant_trials pourri" (résidu) :

```sql
-- Sur Hub DB
UPDATE hub_app.tenant_trials
SET state = 'converted', updated_at = NOW()
WHERE tenant_id IN (
  SELECT t.id::text FROM hub_app.tenants t
  WHERE t.user_id = '<supabase_user_id>' AND t.deleted_at IS NULL
)
AND state IN ('eligible', 'trial_active', 'trial_ending_soon');
```

Vérifier ensuite :
1. Le client se reconnecte → bandeau "essai" doit disparaître (gate
   `hasActiveSubscription` côté layout)
2. Aucun mail trial ne partira plus (le cron skip les `converted`)

## 7. Investigation cause racine

Si tu as dû fixer à la main, c'est qu'une couche a échoué. Vérifier dans
l'ordre :

1. **Webhook reçu mais purge échouée** : logs `[stripe-sync] tenant_trials
   purge → converted failed` — Postgres temporairement down ? Connection
   pool saturé ?
2. **Webhook reçu mais sub pas remontée comme active** : `manageSubscriptionStatusChange`
   a un `isActive = ['active', 'trialing'].includes(status)` — si Stripe
   envoie un status inattendu (incomplete, past_due au moment du create),
   la purge ne tournera pas
3. **Webhook jamais arrivé** : `STRIPE_WEBHOOK_SECRET` rotation ratée ?
   IP allowlist ? voir `runbooks/services/hub/deploy.md`
4. **Cron `processEndingSoon` skip rate** : depuis 2026-05-24, ce cron
   purge en plus à `converted` quand il croise sub active. Logs :
   `[trial-tick] notify-ending-soon skipped (sub active) ... → purged
   to converted` — si tu vois ça souvent, c'est que le webhook n'a pas
   purgé en amont, à investiguer

## 8. Garde-fous existants

Code-side (depuis 2026-05-24) :

- `utils/stripe/prisma-sync.ts` §1ter : purge automatique au webhook
- `lib/trial/run-tick.ts:processEndingSoon` : skip + auto-purge si sub active
- `lib/trial/run-tick.ts:processFinalize` : reste de la sécurité (bascule
  converted au lieu d'expired si sub trouvée)

UI-side :

- `app/dashboard/layout.tsx` : `hasActiveSubscription` masque le bandeau
- `lib/trial/banner-state.ts:85` : retourne `null` direct si sub active

Cron à venir :

- Drift detection (`todo/2026-05-24-drift-detection-trial-vs-sub.md`)
  scannera quotidiennement et alertera Telegram sur incohérences

---

## 9. Documentation associée

- Audit complet : `docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md`
- Pricing source de vérité : `docs/PRICING-VERIDIAN.md`
- CONTRAT-BILLING : `docs/CONTRAT-BILLING.md`
- Ticket source : `todo/2026-05-23-audit-trial-residus-apres-paiement.md`
