# Runbook — Drift cross-app Hub ↔ apps downstream

> **Quand utiliser ce runbook** : un user te signale qu'il ne peut pas
> acheter un truc (refill leads, upgrade plan, etc.) alors qu'il est bien
> connecté côté app. Ou bien le cron `hub-reconcile-cron.yml` détecte des
> drifts.
>
> **Promesse Veridian** : un workspace côté app doit toujours avoir une
> row `hub_app.tenants` correspondante (`id` = `workspace.tenant_id`),
> sinon les routes Hub qui valident l'ownership refusent 404.

---

## Symptôme typique

```
POST https://app.veridian.site/api/billing/refill-leads/checkout
→ 404 {"error":"tenant_not_found_or_forbidden","tenantId":"462a4295-..."}
```

Côté user : "j'ai cliqué Acheter, ça m'a dit 404" alors que le workspace
existe bien côté Prospection (vérifiable via UI Prospection).

---

## Diagnostic — l'ordre des vérifications

### 1. Le tenant existe-t-il côté Hub ?

```bash
ssh prod-pub
# puis dans le container Postgres :
psql $DATABASE_URL -c "SELECT id, user_id, status, deleted_at, prospection_plan, notifuse_workspace_slug FROM hub_app.tenants WHERE id = '<tenantId>';"
```

- **0 rows** : drift `tenant_extra_app` (app a, Hub ignore) → **action 2.A**
- **1 row mais status=deleted ou deleted_at IS NOT NULL** : drift
  "soft-deleted unilaterally" → action 2.B
- **1 row active mais user_id != user attendu** : drift ownership
  (cas rare, contacter Robert)

### 2. Lancer un audit reconcile pour voir l'ampleur

```bash
CRON_SECRET=$(grep '^CRON_SECRET=' ~/credentials/.all-creds.env | cut -d= -f2-)
curl -sX POST "https://app.veridian.site/api/cron/reconcile-tenants?limit=500" \
  -H "Authorization: Bearer $CRON_SECRET" \
  | jq '.drifts | group_by(.kind) | map({kind: .[0].kind, count: length})'
```

Réponse attendue (état nominal 2026-05-25) :

```json
[
  { "kind": "app_unreachable", "count": 34 },   // analytics+cms ENV manquantes → OK
  { "kind": "tenant_missing_app", "count": 18 } // Notifuse 200/body-vide → OK
]
```

Tout `tenant_extra_app` ou `plan_mismatch` au-dessus de la baseline ci-dessus = vraie alerte.

⚠️ **Limite connue** : le reconcile actuel scanne **les tenants Hub**,
pas les workspaces apps. Il ne détecte pas les workspaces orphelins
purs (existent côté app, aucune trace Hub). Pour ce cas, utiliser le
script backfill ciblé en action 2.A.

---

## Action 2.A — Backfill Hub d'un tenant orphelin

Le script `scripts/admin/backfill-hub-tenant-from-app.ts` insère une
row `hub_app.tenants` minimale pour ré-aligner le drift.

### Étape 1 — Récupérer les 3 infos requises

- `app` : `notifuse` | `prospection` | `analytics` | `cms`
- `tenantId` : l'UUID du workspace côté app (visible dans logs Hub
  refill, ou via UI Prospection `/dashboard/workspace/settings`)
- `ownerEmail` : email du user (visible dans le ticket support ou
  via la session Hub)

### Étape 2 — Lancer en dry-run (toujours)

```bash
cd /opt/hub/current   # ou le worktree local du Hub
pnpm tsx scripts/admin/backfill-hub-tenant-from-app.ts \
  --app prospection \
  --tenant-id 462a4295-8e9b-4ef1-b107-7358f1739ba8 \
  --owner-email client@example.com
```

Réponse type :

```
Outcome: created
Tenant 462a4295-... sera créé (user_uuid=aaaa-...). Relancer avec --execute.
```

Si la réponse est `user_not_found` : le user n'a pas de row côté Hub
(orphelin profond). **NE PAS** le créer en aveugle. Contacter Robert
pour décider entre : (1) créer un User Hub puis backfill, (2) marquer
le workspace app deleted_at.

Si la réponse est `already_backfilled` : la row Hub existe déjà
(autre process a backfill entre temps). Pas d'action.

### Étape 3 — Validation Robert avant écriture

**Obligatoire**. Le mode write touche la DB prod, c'est un tier 💀
selon §20 du `docs/CI-ARCHITECTURE.md`.

Présenter à Robert : dry-run output + tenant cible + email cible →
attendre OK explicite.

### Étape 4 — Execute (write réel)

```bash
pnpm tsx scripts/admin/backfill-hub-tenant-from-app.ts \
  --app prospection \
  --tenant-id 462a4295-8e9b-4ef1-b107-7358f1739ba8 \
  --owner-email client@example.com \
  --execute
```

Réponse attendue :

```
Outcome: created
Tenant 462a4295-... CRÉÉ (user_uuid=aaaa-...)
```

### Étape 5 — Valider que le refill remarche

Demander au user de retenter l'achat. Côté logs :

```bash
ssh prod-pub 'docker logs <hub-container> --tail 200 | grep refill-leads/checkout'
```

→ doit voir 200 OK avec création Stripe session.

---

## Action 2.B — Tenant soft-deleted côté Hub uniquement

Si la row existe mais `status=deleted` ou `deleted_at IS NOT NULL`,
deux scénarios :

1. **Suppression légitime** : le user a vraiment quitté → l'app doit
   aussi soft-delete son workspace. Ouvrir ticket côté app concernée
   pour propagation. NE PAS réactiver le Tenant Hub sans Robert.
2. **Suppression erronée** (cleanup cron qui s'emballe, repair-script
   destructif) : réactiver via :
   ```sql
   UPDATE hub_app.tenants
     SET status = 'active', deleted_at = NULL, cleanup_notified_at = NULL
     WHERE id = '<tenantId>';
   ```
   → exécuté uniquement après go explicite de Robert (tier 💀).

---

## Cron quotidien — `hub-reconcile-cron.yml`

Workflow GH Actions horaire (cron `17 * * * *`) qui invoque le reconcile
en prod. Mode dry-run forcé (P0). Notifie Telegram via le bot si la
job CI échoue, et alerte au-dessus du seuil `RECONCILE_ALERT_THRESHOLD`
(défaut 5 drifts) via `sendTelegramAlert()`.

### Lecture des runs

- Dashboard : https://github.com/Christ-Roy/veridian-hub/actions/workflows/hub-reconcile-cron.yml
- Filtrer sur "completed" → ouvrir le run → step "Call /api/cron/reconcile-tenants"
- Le JSON de réponse est dump dans les logs (champ `drifts`)

### Désactiver temporairement le cron (maintenance)

Quand on fait une migration DB qui va générer du bruit (rotation
massive de plans, etc.) :

```bash
gh workflow disable hub-reconcile-cron.yml
# ... maintenance ...
gh workflow enable hub-reconcile-cron.yml
```

### Tuner le seuil d'alerte

Le seuil par défaut est 5 (envoie Telegram si `driftsDetected >= 5`).
Trop bas en ce moment vu la baseline de 53 drifts non-actionnables
(analytics/cms unreachable + notifuse body vide). Tant que ces drifts
de configuration ne sont pas fixés :

- Soit augmenter `RECONCILE_ALERT_THRESHOLD` côté Dokploy ENV à 60
- Soit ajouter le filtre `?apps=prospection,notifuse` au workflow pour
  exclure analytics/cms — **mais Notifuse reste 17 drifts faux positifs
  tant que son endpoint by-email ne répond pas correctement**

Recommandation : laisser le seuil à 5 et filtrer `?apps=prospection`
au workflow tant que les autres drifts ne sont pas fixés. À ouvrir en
ticket post-mortem.

---

## Anti-patterns — à NE PAS faire

- ❌ Désactiver le P0 lock dry-run du `runReconcile` côté code pour
  "tester l'auto-repair en prod". Le code force `mode='dry-run'`
  même si l'opérateur passe `autoRepair=true` (cf
  `lib/sync/reconcile.ts:257-262`). Cette garde reste tant que toutes
  les apps n'ont pas livré leur endpoint discovery prod.
- ❌ Lancer le script backfill en `--execute` sans validation Robert.
- ❌ Backfill un tenant avec un email arbitraire pour "voir si ça
  marche". L'`id` du Tenant est aussi la PK — une fois inséré, l'undo
  est destructif.
- ❌ Modifier `prisma/schema.prisma` pour assouplir des FK afin de
  passer ce backfill. Si la structure refuse, c'est qu'il y a une vraie
  raison (FK Subscription / User) → diagnostic en amont.

---

## Postmortem & tickets de suite

- `docs/AUDIT-TENANT-DRIFT-2026-05-25.md` : audit initial qui a justifié
  ce runbook
- `todo/2026-05-25-tenant-drift-cross-app-detected.md` : ticket d'origine
- À ouvrir : ticket Hub pour étendre le reconcile en mode
  "discovery-first" (itère sur `User.email` au lieu de `Tenant.id`,
  permet de détecter les `tenant_extra_app` purs)
- À ouvrir côté Notifuse : fixer la réponse vide de
  `GET /api/users/by-email` en prod
