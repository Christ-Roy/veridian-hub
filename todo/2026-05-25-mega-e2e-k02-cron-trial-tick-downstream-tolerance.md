# [HUB] MEGA E2E — K-02 cron trial-tick fait downstream Notifuse sur fixtures Hub-only

> **Sévérité** : 🟢 P2 — bloque 1 spec MEGA (K-02), pas un bug prod
> **Owner** : agent Hub
> **Créé** : 2026-05-25 par team-lead mega-e2e

## Contexte

Spec `K-02 parallel trial ticks` crée 3 rows fixtures `tenant_trials` directement en DB Hub via `ensureTenantForTrial()`, avec tenantId `mega-k-{stamp}-cron-{a,b,c}`. Le cron `/api/cron/trial-tick` est ensuite invoqué 2× en parallèle pour valider l'invariant `SELECT FOR UPDATE SKIP LOCKED`.

**Problème** : le cron tente de propager l'activation côté Notifuse downstream via HMAC (`POST /api/tenants/update-plan`) et reçoit "tenant not found" puisque le tenant fixture est Hub-only. Résultat :

```
errors: [{"tenantId":"mega-k-..-cron-a","app":"notifuse","phase":"activate","error":"tenant not found"}]
activated: 0 (au lieu de 3)
```

## Options de fix

**Option A** (recommandée) : modifier la spec K-02 pour créer aussi les tenants Notifuse downstream (via SSH + psql sur notifuse-staging-db). Plus coûteux mais teste le cycle complet.

**Option B** : tolérer "tenant not found" dans l'assert K-02 — vérifier `activated + errors.length === 3` au lieu de `activated >= 3`. Mais ne teste plus l'invariant SKIP LOCKED.

**Option C** : ajouter un mode `dryRun=true` au cron qui skip le downstream call. Pour les fixtures Hub-only, l'invariant DB est testable sans downstream.

## Spec impactée
- `e2e/staging-full/mega/K-race-conditions/K-02-parallel-trial-ticks.spec.ts:143`
