# e2e/tunnel — JUGE DE PAIX de la parité bridge → Hub (gates G0→G10)

> Un seul verdict 🟢/🔴 : la chaîne `webhook → ingestion → DB → scoring découplé
> → score` du **Hub** reproduit-elle ce que faisait l'ancien **bridge**
> (`veridian-tunnel-de-vente/bridge/`) ? Si oui, on peut débrancher le bridge.

C'est le **portage** de `veridian-tunnel-de-vente/tunnel-e2e/` (qui tapait le
bridge dev-pub + SQLite) vers le **Hub staging** (Postgres + cron de scoring
découplé). Pas un copier-coller : l'archi cible est différente (cf. ci-dessous).

## Lancer

```bash
# Source les secrets du container hub-staging puis lance les gates :
pnpm e2e:tunnel
# Un gate précis :
pnpm e2e:tunnel -- --grep G8
# Override la cible :
STAGING_URL=https://hub.staging.veridian.site pnpm e2e:tunnel
```

Exit 0 = 🟢 parité prouvée, 1 = 🔴 au moins un gate rouge. Pré-requis :
`ssh dev-pub` OK (sourcing des secrets + lecture DB via `runSqlOnStaging`).

## L'écart structurel porté (PAS un re-pointage d'URLs)

| Aspect | bridge (référence) | Hub (cible) |
|---|---|---|
| Store events | SQLite (`docker exec`) | Postgres `hub_app.prospect_events` (psql) |
| Scoring | **à l'ingestion**, push Twenty immédiat | **DÉCOUPLÉ** : cron `push-prospect-scores` |
| Score en DB | store + Twenty | `hub_app.prospect_scores` (écrit par le cron) |
| Ancre parité | `computeTunnelScore` (bridge) | `getScoringEngine('tunnel-v2')` (Hub) |
| Validation | score dans Twenty | score dans `prospect_scores` après tick cron |
| Push CRM | toujours | LOGUÉ en DRY_RUN (+ 0 CrmTenant → skip gracieux) |

**Conséquence** : le point de parité n'est plus « le score dans Twenty » mais
« le score dans `hub_app.prospect_scores` après un tick du cron, en DRY_RUN ».

## Les gates (correspondance bridge → Hub)

| Gate | Quoi | Échec typique |
|---|---|---|
| **G0** | préflight — **REFUSE de tourner** si l'allowlist test ne filtre pas, si `CRON_SECRET` absent, si le cron n'est pas en DRY_RUN, ou si le Hub est injoignable | garde-fou manquant |
| **G2** | `email.opened` signé HMAC ×5 → 5 rows `prospect_events` (OPEN_FIRST +5) | secret HMAC désaligné |
| **G5** | `email.clicked` ×2 signés HMAC ×5 (CLICK_FIRST +20 + CLICK_EXTRA +10) | webhook/signature |
| **G5b** | `email.replied` signé HMAC ×5 (EMAIL_REPLIED +35) | ingestion reply |
| **G6** | voie events web : tick du cron `pull-analytics` tourne sans crasher | cron web KO |
| **G7** | tick du cron `push-prospect-scores` (DRY_RUN) → ≥5 scores écrits | 401 CRON_SECRET / cron KO |
| **G8** | **PARITÉ** : `prospect_scores.engagement_score == getScoringEngine('tunnel-v2')` recalculé sur les events RÉELS lus en DB + label + signals ; push Twenty LOGUÉ (`dryRun=true`, `noCrmTenant≥5`) | divergence ingestion/agrégation/barème |
| **G8b** | **CONCURRENCE** : 10× `email.opened` en parallèle → tous ingérés + score == engine (atomicité, fix 61d4cc6) | events perdus sous course |
| **G8c** | scope V1 : `email.bounced` hors-scope ignoré des 2 côtés → parité tient | scope V1 violé |
| **G9** | replay du MÊME `event_id` → 0 doublon (`idempotency_key` UNIQUE) + re-tick → score INCHANGÉ | dédup / double comptage |
| **G10** | garde-fou final (0 email hors allowlist scoré) + purge des rows E2E | fuite d'écriture |

## L'ancre de parité (le cœur)

G8 **ne hardcode aucun nombre**. L'attendu est calculé en rejouant le **code de
prod** (`aggregateSignals` + `getScoringEngine('tunnel-v2')`, importés depuis
`lib/prospect/scoring.ts`) sur les events **réellement lus en DB**. Si
`prospect_scores.engagement_score == ce recalcul`, c'est que le cron du Hub et
l'ancre calculent identiquement → **parité prouvée**.

Score attendu d'un parcours email complet (opened +5, 2 clics +30, replied +35) :
`5 + 30 + 35 = 70`, ×1.5 récence (<48h) = `105` → cap **100** → label `chaud`.
Mais on ne l'écrit pas en dur : on le dérive du code, et on assert juste `> 30`
(chaud) pour éviter un faux-vert trivial `0 == 0`.

## Scope V1 d'ingestion (contrat §7.5.1) — pourquoi la famille email

Le réconciliateur n'ingère au V1 que `email.opened` / `email.clicked` /
`email.replied` (les seuls câblés sur la voie webhook réelle de prod). PAS
`email.sent` (compteur legacy seul), PAS `email.bounced`/`email.unsubscribed`
(barème prêt mais aucun émetteur), PAS `page.hit` (voie = cron pull-analytics,
route webhook à créer). Ce ne sont pas des bugs : c'est le scope V1 documenté.

La parité de score se prouve donc sur la famille email du scope V1 — celle que
100 % des prospects ont. G8c prouve que les events hors-scope sont ignorés
identiquement par le Hub et par l'ancre (donc la parité tient). Le constat prod
"bounce non disqualifiant au V1" est tracé : `todo/2026-06-17-ingestion-bounce-unsub-disqualif-reconciliateur.md`.

## Garde-fous (sinon on pollue le vrai CRM de Robert)

- **Allowlist** (porté de `gateWriteAllowlist`) : seuls les emails
  `tunnel-e2e-*@e2e.veridian.site` sont touchés. `isTestEmail()` refuse tout le
  reste. Combiné au `workspace_slug` unique par `RUN_STAMP` → isolation totale.
- **DRY_RUN OBLIGATOIRE** : G0 refuse de courir si le cron ne retourne pas
  `dryRun=true`. Les mutations Twenty sont LOGUÉES, jamais envoyées. La bascule
  réelle (`CRON_PUSH_DRY_RUN=false`) viendra après, sur GO Robert.
- **Garde-fou final** (G10, porté d'`assertNoRealProspectTouched`) : 100 % des
  emails scorés dans le workspace test sont des emails de test. Toute fuite = 🔴.

## Secrets

Auto-sourcés par `scripts/e2e/tunnel-gates.sh` depuis le container `hub-staging`
(source de vérité, comme `staging-full.sh` étape 0bis) :
`NOTIFUSE_HUB_WEBHOOK_SECRET`, `NOTIFUSE_WEBHOOK_TOKEN`, `CRON_SECRET`. Rien
d'autre. Fallbacks alignés sur la spec 21 pour les deux secrets webhook.

## Limites connues (honnêtes)

- **Parité prouvée sur la famille EMAIL (scope V1)**, pas sur la famille
  Analytics : `page.hit` n'a pas de voie d'ingestion webhook au V1 (cron
  pull-analytics seul, fenêtre engine 48h non isolable). G6 prouve que la voie
  web existe/tourne ; la parité du barème Analytics sera ajoutée quand la route
  `/api/webhooks/analytics` câblera `page.hit` (cf contrat §7.5).
- **Pas de famille « cycle » (delete→recreate Person Twenty)** comme dans le
  bridge : sans écriture CRM réelle (DRY_RUN + 0 CrmTenant), il n'y a pas de
  Person à recréer. La rejouabilité est prouvée par G9 (dédup) + G10 (cleanup) +
  l'isolation par `RUN_STAMP` (chaque run repart d'un workspace vierge — vérifié
  2026-06-17 : 2 runs consécutifs verts, DB à 0 row résiduelle après).
- **Push CRM en DRY_RUN** : on valide la SÉQUENCE et le SCORE en DB, pas
  l'écriture Twenty réelle (loguée). La bascule `CRON_PUSH_DRY_RUN=false` viendra
  sur GO Robert, avec ces gates re-roulés en mode réel (allowlist + CrmTenant test).
