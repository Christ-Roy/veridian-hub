# [HUB] Drift cross-app détecté : workspaces Prospection sans tenant Hub

> **Type** : Cohérence cross-app — risque produit
> **Sévérité** : 🔴 P1 — bloque le refill pour les tenants en drift
> **Owner** : agent Hub + agent Prospection (coordination)
> **Créé** : 2026-05-25 par team-lead Hub
> **Découvert via** : test refill leads bout-en-bout réel (2026-05-25 22:35)
> **Refs** :
> - `lib/sync/reconcile.ts` (cron reconcile déjà câblé en dry-run)
> - `app/api/admin/reconcile-trigger/route.ts` (UI admin pour trigger manuel)

---

## Symptôme observé en réel

Test refill leads bout-en-bout staging du 2026-05-25 : workspace Prospection
`tenant_id=462a4295-8e9b-4ef1-b107-7358f1739ba8` existe en DB Prospection
mais **PAS en DB Hub** (`SELECT FROM hub_app.tenants WHERE id = ... → 0 rows`).

Conséquence directe : le dispatcher refill Hub appelle
`POST <prospection>/api/tenants/462a4295.../credit-leads` qui retourne 200
côté Prospection (workspace existe), mais côté Hub la route checkout
`POST /api/billing/refill-leads/checkout` refuse direct le tenantId
(`tenant_not_found_or_forbidden`) parce que l'ownership check Prisma ne
trouve pas le tenant.

**Le user ne peut donc PAS acheter de leads via la page Hub** même s'il a
un workspace Prospection actif.

## Probables causes racines

1. **Provisioning manuel direct côté Prospection** (scripts admin, seed,
   migration) qui ne notifie pas le Hub
2. **Hub → Prospection provisioning v1 ancien** qui posait le tenant
   uniquement côté Prospection
3. **Tenant supprimé côté Hub** (soft-delete) sans propagation Prospection
4. **Bug pre-v1.4** : `Tenant.id` Hub n'était pas aligné sur
   `Workspace.tenant_id` Prospection (le sync 1:1 est récent)

## Action immédiate

Lancer le cron reconcile (déjà livré, déjà câblé sur Hub via
`/api/cron/reconcile-tenants`) en mode dry-run pour identifier la liste
complète des drifts :

```bash
curl -X POST https://app.veridian.site/api/cron/reconcile-tenants \
  -H "Authorization: Bearer $CRON_SECRET" \
  | jq '.drifts_detected'
```

Ou via UI admin : `/dashboard/admin` → Card "Audit cross-app (dry-run)"
→ bouton "Lancer audit".

## Action curative

Pour chaque drift `Prospection HAS workspace ∧ Hub MISSING tenant` :

**Option A — Backfill Hub** (préféré) : créer le Tenant Hub manquant en
matchant `Tenant.id = Workspace.tenant_id`, avec `user_id` = lookup user
Hub via `email == workspace.owner_email`.

**Option B — Mark workspace Prospection soft-deleted** : si l'audit
business confirme que ces workspaces sont obsolètes / tests / corrompus,
les marquer `deleted_at = NOW()` côté Prospection.

## Action structurelle (anti-régression)

- **Désactiver tout provisioning direct côté apps downstream** sans appel
  préalable à `POST <hub>/api/admin/tenants/link-app` (déjà livré, cf
  `app/api/admin/tenants/link-app/route.ts`)
- **Activer le cron reconcile en mode `report-only` quotidien** avec
  alerte (Telegram OFF, donc Notifuse mail à `support@veridian.site` ?)
  si drifts > 0
- **Étendre la spec E2E `21-tenant-sync-reconcile.spec.ts`** (déjà existe)
  pour couvrir explicitement le scenario "drift refill"

## Definition of done

- [ ] Run reconcile complet sur prod + staging, liste exhaustive des drifts
- [ ] Backfill Hub des tenants manquants (script idempotent)
- [ ] Cron `report-only` quotidien activé en prod
- [ ] Doc runbook `runbooks/services/hub/tenant-drift-recovery.md` créée
- [ ] Spec E2E étendue
- [ ] Validation refill bout-en-bout sur 3 tenants différents post-backfill

## Notes pour suite

L'incident d'aujourd'hui (2026-05-25) montre que **la promesse
"client paie = leads crédités" peut casser silencieusement** si le tenant
n'est pas en sync cross-app. Avec le cron reconcile activé, on détecte
ces cas avant qu'un user clique "Acheter" et se retrouve avec un 4xx.
