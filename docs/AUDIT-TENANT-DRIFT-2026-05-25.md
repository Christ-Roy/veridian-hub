# Audit drift cross-app Hub ↔ apps downstream — 2026-05-25

> **Origine** : ticket `todo/2026-05-25-tenant-drift-cross-app-detected.md`
> **Trigger** : test refill leads bout-en-bout détecte qu'un workspace
> Prospection `tenant_id=462a4295…` n'a pas de row `hub_app.tenants`
> correspondante, ce qui fait échouer `POST /api/billing/refill-leads/checkout`
> avec `tenant_not_found_or_forbidden`.
> **Tooling** : cron `POST /api/cron/reconcile-tenants?limit=500` (mode
> dry-run forcé P0), implémenté dans `lib/sync/reconcile.ts`.

---

## Résumé exécutif

| Métrique | Valeur |
|---|---|
| Tenants Hub scannés (status=active, deletedAt=null) | **17** |
| Apps interrogées (4 apps × tenants) | 68 |
| **Drifts détectés** | **53** |
| Apps unreachable (timeout / not_configured / 5xx) | 34 |
| Mode | `dry-run` (P0 forcé) |
| Durée | 387 ms |
| Erreurs runtime | 0 |

## Drifts par type

| `DriftKind` | Count | Lecture |
|---|---|---|
| `app_unreachable` | 34 | 100 % côté `analytics` + `cms` → ENV `*_API_URL` / `*_HUB_API_SECRET` pas câblés en prod (apps shadow non livrées) |
| `tenant_missing_app` | 18 | Hub croit avoir l'app, l'app répond `{found:false}` |
| `plan_mismatch` | 1 | Hub.prospectionPlan ≠ snapshot.plan |
| `tenant_extra_app` | **0** | Voir §"Limite de détection ci-dessous" |
| `status_mismatch` | 0 | — |

## Drifts par app

| App | Count | Détail |
|---|---|---|
| `analytics` | 17 | 17/17 `app_unreachable` — ENV pas câblées (`ANALYTICS_API_URL` / `ANALYTICS_HUB_API_SECRET`) |
| `cms` | 17 | idem, ENV pas câblées (`CMS_API_URL` / `CMS_HUB_API_SECRET`) |
| `notifuse` | 17 | 17/17 `tenant_missing_app` — voir §"Notifuse — drift de masse" |
| `prospection` | 2 | 1 `tenant_missing_app` (`bd9c5bac-…`) + 1 `plan_mismatch` (`359b76d5-…`, Hub=enterprise vs app=pro) |

## Notifuse — drift de masse (17/17)

Discovery prod sur `https://notifuse.app.veridian.site/api/users/by-email`
renvoie systématiquement **HTTP 200 + body vide** (vérifié manuellement) au
lieu d'un JSON `{found, workspaces[]}`. Côté Hub, `discovery.ts` interprète
le body vide en `{found:false}` (cf. lignes 165-182 de `lib/sync/discovery.ts`),
ce qui aboutit à `tenant_missing_app` pour les 17 tenants qui ont
`notifuse_workspace_slug` non-null en DB Hub.

**Conclusion** : ce n'est PAS un drift business réel. C'est un **drift de
configuration discovery** : l'endpoint `GET /api/users/by-email` de
Notifuse en prod ne traite pas (encore) correctement l'auth HMAC Hub →
réponse 200 sans corps. Le ticket
`notifuse-veridian/todo/...-discovery-endpoint.md` est probablement livré
côté staging mais pas câblé en prod (HMAC à valider).

**Action** : ticket à ouvrir côté Notifuse pour fixer la handler discovery
prod. Hors scope de ce ticket Hub. À tracker via :
`notifuse-veridian/todo/2026-05-25-discovery-by-email-prod-empty-body.md`.

## Prospection — drifts business réels

### `bd9c5bac-417e-976f-4200121b9aac` — `tenant_missing_app`

Le Hub croit avoir une row Prospection (`prospectionPlan=freemium`), mais
Prospection répond `{found:false}` pour cet email.

Hypothèses :
1. Workspace soft-deleted côté Prospection (sans webhook back au Hub)
2. Email user Hub désaligné avec workspace owner Prospection (changement
   d'email après provisioning)
3. Provisioning Prospection a foiré à mi-parcours (Hub a déjà commité
   `prospectionPlan` avant le rollback côté app)

→ Doit être investigué cas par cas. Pas de backfill auto.

### `359b76d5-bab7-4773-a889-cf4cf0248869` — `plan_mismatch`

Hub.prospectionPlan = `enterprise`, snapshot = `pro`. Désynchro source de
vérité Stripe : soit le webhook `customer.subscription.updated` n'est pas
arrivé côté Prospection, soit la dernière update plan ne s'est pas
propagée.

→ Ticket à ouvrir : `todo/2026-05-25-plan-mismatch-359b76d5-prosp.md`.
Pas de fix global, c'est un cas isolé.

## Apps shadow (analytics / cms) — apps_unreachable de masse

ENV `ANALYTICS_API_URL` + `ANALYTICS_HUB_API_SECRET` + `CMS_API_URL` +
`CMS_HUB_API_SECRET` ne sont pas câblés en prod sur Hub. Comportement
attendu : ces apps ne sont pas encore en SaaS public.

→ Pollution sans gravité dans les drifts. À filtrer côté reporting
quand on activera le cron quotidien (`apps=notifuse,prospection`).

## Limite de détection du reconcile actuel — `tenant_extra_app`

**0 drift `tenant_extra_app` détecté**, alors que le ticket source
documente un workspace Prospection `462a4295-…` connu sans row Hub.

**Cause** : le reconcile actuel (`lib/sync/reconcile.ts:189-237`) part
de `prisma.tenant.findMany({ status:'active' })` → il itère sur **les
tenants Hub** et croise avec discovery par email. Il ne peut pas
détecter un workspace Prospection orphelin qui **n'a aucun tenant Hub
correspondant** (lookup user via Tenant.userId, pas via email
indépendamment).

Pour détecter ces cas, il faudrait inverser le sens du reconcile :
itérer sur **tous les users Hub** (`User.email`) et croiser avec
discovery, indépendamment de l'existence d'un Tenant. C'est un autre
mode du reconcile (mode "discovery-first"), à câbler dans un sprint
suivant.

En attendant, le **script backfill** livré aujourd'hui
(`scripts/admin/backfill-hub-tenant-from-app.ts`) accepte un
`(app, tenant_id)` en input et fait le lookup → backfill ciblé, pas de
scan exhaustif. C'est l'outil de réparation manuel pour les cas
détectés par d'autres canaux (test refill, ticket support).

## Liste complète des drifts (50 + sample)

Voir `/tmp/reconcile-resp.json` (réponse JSON brute de l'invocation cron
prod du 2026-05-25 08:20:52 UTC) pour la liste exhaustive avec
`hubTenantId` + `kind` + `hubValue` + `appValue`. Réponse archivée hors
git (taille 30+ KB).

## Recommandations actionnables

### Immédiates (livrées par ce sprint)

- ✅ Script `scripts/admin/backfill-hub-tenant-from-app.ts` (dry-run par
  défaut) pour réparer un drift `(app, tenant_id)` connu
- ✅ Cron quotidien `hub-reconcile-cron.yml` déjà câblé (existait
  pre-sprint) — vérifié toujours actif
- ✅ Runbook `runbooks/services/hub/tenant-drift-recovery.md` créé

### À ouvrir en tickets séparés

- 🔵 `notifuse-veridian/todo/...-discovery-by-email-prod-empty-body.md`
  — fixer le handler discovery Notifuse prod
- 🔵 `veridian-hub/todo/2026-05-25-plan-mismatch-359b76d5-prosp.md` —
  investiguer le `plan_mismatch` Prospection
- 🔵 `veridian-hub/todo/2026-05-25-reconcile-mode-discovery-first.md`
  — étendre `lib/sync/reconcile.ts` avec un mode qui itère sur
  `User.email` (pas `Tenant`) pour détecter les `tenant_extra_app` purs
- 🔵 `veridian-prospection/todo/2026-05-25-investiguer-tenant-bd9c5bac.md`
  — savoir si le workspace est soft-deleted ou si discovery foire

## Réplicabilité

```bash
# Lancer un audit ad-hoc en prod
CRON_SECRET=$(grep '^CRON_SECRET=' ~/credentials/.all-creds.env | cut -d= -f2-)
curl -sX POST "https://app.veridian.site/api/cron/reconcile-tenants?limit=500" \
  -H "Authorization: Bearer $CRON_SECRET" \
  | jq '.drifts | group_by(.kind) | map({kind: .[0].kind, count: length})'
```

Réponse type :

```json
[
  { "kind": "app_unreachable", "count": 34 },
  { "kind": "plan_mismatch", "count": 1 },
  { "kind": "tenant_missing_app", "count": 18 }
]
```
