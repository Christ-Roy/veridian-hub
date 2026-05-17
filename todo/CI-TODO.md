# CI Veridian — TODO dédié

> **Spec de référence** : `~/Bureau/veridian-platform/CI-ARCHITECTURE.md` (1206 lignes, validé 2026-05-13).
> Ce fichier suit l'**implémentation** chantier par chantier — fait / en cours / à faire.
> Mis à jour à chaque action significative sur la CI Hub.

## 🚀 État actuel (post-session 2026-05-14)

**Session marathon** : 3 PR mergées sur main, infra staging activée, 🔥 mode Nuclear actif.

### Ce qui tourne maintenant en prod
- ✅ Hub `/dashboard` débloqué (fix RSC Next 15) — validé visuellement Chrome
- ✅ Compose modulaire `base + prod + staging` avec wrapper `include:` (byte-exact)
- ✅ Pipeline complet vert sur 3 deploys consécutifs (PR #17, #18, #19)

### Garde-fous CI actifs
- 🔥 **Mode Nuclear** : 0 dette tolérée sur business logic (API routes, components hors ui, hooks, lib)
- ✅ `check-test-mapping.sh` côté CI étage 1 + pre-push hook local (impossible à bypass)
- ✅ `check-compose-sync.sh` côté CI étage 1 + pre-push hook si compose modifié
- ✅ Supply chain : `--ignore-scripts` partout (CI + Dockerfile) + whitelist `pnpm.onlyBuiltDependencies`
- ✅ Audit CVE high+critical bloquant
- ✅ Trivy image scan
- ✅ Auto-rollback Docker si smoke prod fail

### Infrastructure staging dispo
- ✅ Traefik standalone sur dev (`~/traefik-staging/`)
- ✅ User SSH `staging-deploy` + clé déployée
- ✅ Secrets/vars GitHub repo configurés (5 entrées)
- ✅ Workflow `hub-staging.yml` prêt — déclenche sur push branche `staging`
- ✅ URL : `https://hub.staging.veridian.site` (cert wildcard ACME)

### Reste à faire (priorisé, post-session 2026-05-17)
1. **Activer Renovate** : installer GitHub App sur l'org Christ-Roy (<https://github.com/apps/renovate>) — action humaine
2. **Workflow réutilisable `_app-ci.yml`** (chantier #6) — ticket déposé chez agent infra
3. **Backward-compat test** (chantier #13) — image previous vs schéma N, évite rollback qui crash DB
4. **Emergency revert/rollback** (chantiers #20, #21)
5. **Auto-merge total + branch protection 8 checks** (chantier #25) — Robert hors boucle
6. **Annotations Grafana** `obs annotate deploy` (chantier #26)
7. **MSW + happy-dom + RTL** (chantiers #14, #15) — test stack moderne
8. **size-limit bundle budget** (chantier #16)
9. **Synthetic monitoring 5 min** (chantier #27) — baseline auto
10. **Coverage hooks/lib** (chantier #28) — mapping ne couvre que API

---

**Légende :**
- ✅ Fait + en prod
- 🟡 Fait localement, pas encore mergé
- ⏳ En cours
- 🔲 À faire
- ❌ Abandonné / remplacé

---

## 🎯 État synthétique

| Chantier | État | Bloque quoi |
|---|---|---|
| 1. Script de mapping route↔test | ✅ Versionné + exécutable + 🔥 mode Nuclear | — |
| 2. Husky pre-push hook | ✅ Installé + actif (mapping + compose-sync) | — |
| 2b. **`check-test-mapping.sh` côté CI étage 1** | ✅ **PR #19** (anti `--no-verify`) | — |
| 2c. **Mode Nuclear** (0 dette business logic) | ✅ **PR #19** | — |
| 3. Baseline `tests-pending.txt` | ✅ Réduit à 41 (components/ui uniquement) | — |
| 4. `test-coverage-map.yaml` versionné | ✅ Présent (vide, à peupler au fil de l'eau) | — |
| 5. Path-based skip CI étendu | ✅ `docs/**`, `runbooks/**`, `todo/**`, `_archive/**`, `**/*.md` | — |
| 6. Workflow réutilisable `_app-ci.yml` partagé | 🟡 **Ticket posé chez infra** (`veridian-infra/todo/infra/2026-05-17-app-ci-reusable-workflow.md`) | Mutualisation 5 apps |
| 7. Path-based staging gate (changements structurels) | ✅ **PR #23** — `check-structural-changes.sh` + `check-staging-fresh.sh` + job structural-gate | — |
| 8. GitHub Environments staging + production | ✅ **PR #23** — environments créés + câblés dans hub-ci/hub-staging + runbook | — |
| 9. Trivy 9 capacités (vuln/misconfig/secret/license/image/EOL/SBOM/SARIF/cron) | ✅ **PR #23** — FS scan complet, SARIF upload, SBOM CycloneDX, cron hebdo | — |
| 10. SARIF upload → GitHub Security tab | ✅ **PR #23** — codeql-action/upload-sarif@v3 dans _trivy-fs + _trivy-image | — |
| 11. `.trivyignore.yaml` avec VEX | ✅ **PR #23** — `.trivyignore.yaml` (statement + expired_at), `.trivyignore` plat retiré | — |
| 12. Script `check-migration-safety.sh` | ✅ **PR #23** — DROP/RENAME/CREATE INDEX bloquants + acknowledgement `@safe` | — |
| 13. Job `test-backward-compat` (image previous vs schéma N) | 🔲 Pas créé | Auto-rollback peut crasher DB |
| 14. MSW (mock service worker) | 🔲 Pas installé | Tests réseau actuels = `vi.mock` |
| 15. `happy-dom` + RTL + `__tests__/components/` | 🔲 Pas configuré | Component DOM tests |
| 16. `size-limit` (bundle budget +15%) | 🔲 Pas câblé | Bloque Renovate fat-bundle |
| 17. Playwright `retries: 2` + flaky detector | 🟡 Playwright OK, pas de `playwright-flaky-detector.yml` | Flaky → rollback bidon |
| 18. Renovate `renovate.json` (auto-merge total) | ✅ **PR #22 mergée** — Dependabot archivé, Renovate App à installer sur l'org | Activation : <https://github.com/apps/renovate> |
| 19. **Staging fixe sur dev server** | ✅ **Convention `<app>.staging.veridian.site`, push branche `staging`** | — |
| 19a. Compose pattern base + prod + staging (include) | ✅ Mergé via PR #18, byte-exact validé en prod | — |
| 19b. Script `check-compose-sync.sh` + pre-push + CI | ✅ Versionné + actif | — |
| 19c. Workflow `hub-staging.yml` | ✅ Mergé via PR #18 (refondu après convention CLAUDE.md) | — |
| 19d. GC hebdo `staging-gc.sh` | ❌ Abandonné (convention fixe = pas d'orphelins) | — |
| 20. `emergency-revert.yml` (rollback Docker → revert Git) | 🔲 Pas créé | Commit fautif reste sur main |
| 21. `emergency-rollback.yml` (Grafana webhook → rollback) | 🔲 Pas créé | Alertes Grafana = silence |
| 22. `--ignore-scripts` strict | ✅ **PR #19** (CI + Dockerfile) | — |
| 23. `pnpm.onlyBuiltDependencies` whitelist | ✅ **PR #19** (Prisma + Husky + Playwright) | — |
| 24. Cleanup runner `always()` step | ✅ **PR #23** — ajouté dans deploy-prod et rollback-prod | — |
| 25. Auto-merge total PR (8 checks + plus de review humaine) | 🔲 Branch protection à configurer | Robert hors boucle |
| 26. `obs annotate` cablé dans étage 3 (deploy/migrate/rollback) | 🔲 Pas câblé | Timeline Grafana incomplète |
| 27. Synthetic monitoring 5 min sur prod | 🔲 Pas câblé | Baseline absente |
| 28. Coverage hooks/lib (`__tests__/hooks/`, `__tests__/lib/`) | 🔲 Pas créé | Mapping script ne couvre que API |
| 29. **smoke-prod.sh** | ✅ **PR #18** (validation post-deploy) | — |

---

## ✅ Détail de ce qui est fait

### 1. Script `scripts/ci/check-test-mapping.sh`
- **Fichier** : `veridian-hub/scripts/ci/check-test-mapping.sh` (versionné)
- **Comportement** : règle 1-pour-1 stricte
  - Diff Git → liste fichiers modifiés
  - Pour chaque fichier critique : mapping canonique (`app/api/x/route.ts` → `__tests__/api/x.test.ts`)
  - Fallback `test-coverage-map.yaml` si déclaration non-canonique
  - Allowlist `tests-pending.txt` (dette acceptée)
  - Comptage 1-pour-1 : nouveaux exports vs nouveaux `test()`, nouveaux HTTP verbs vs nouveaux `describe()`
  - Migrations Prisma → exige test integration modifié
  - Exit 1 sur la moindre violation
- **Scopes couverts** : routes API, components/, hooks/, lib/ (sauf types/)
- **Modes** : pre-push hook (BASE_REF=origin/<branche>), CI (BASE_REF=origin/main), manuel (BASE_REF=HEAD)
- **Validé** le 2026-05-14 sur PR #17 → mapping OK pour le fix dashboard

### 2. Husky pre-push hook
- **Fichier** : `veridian-hub/.husky/pre-push`
- **Action** : exec `scripts/ci/check-test-mapping.sh` avant chaque push
- **Setup** : `pnpm setup-hooks` (alias `husky`)
- **Vérification** : `--no-verify` interdit par Constitution CI §3

### 3. Baseline `tests-pending.txt`
- **Fichier** : `veridian-hub/tests-pending.txt`
- **Contenu actuel** : 116 fichiers critiques sans test colocalisé (routes API + components + hooks + lib)
- **Cible** : 0 sous 90 jours (résorption progressive PR par PR)
- **Cron hebdo** : 🔲 pas câblé (`wc -l tests-pending.txt` → issue GitHub auto)

### 4. `test-coverage-map.yaml`
- **Fichier** : `veridian-hub/test-coverage-map.yaml`
- **Contenu** : vide (placeholder + doc inline)
- **Usage** : déclarer les couvertures non-canoniques au fur et à mesure

### 5. Path-based skip docs-only
- **Fichier** : `.github/workflows/hub-ci.yml`
- **Lignes 9-12** :
  ```yaml
  paths-ignore:
    - 'todo/**'
    - '_archive/**'
    - '**/*.md'
  ```
- **À ajouter** : `docs/**`, `runbooks/**` (cf Constitution §4)

### 9. Trivy partiel
- **Fichier** : `.github/workflows/_trivy-image.yml` (réutilisable)
- **Capacités câblées** : Image scan (#5), severity CRITICAL+HIGH bloquant
- **Manque** : FS scan vuln (#1), config (#2), secret (#3), license (#4), EOL (#6), SBOM CycloneDX (#7), SARIF upload (#8), cron hebdo running (#9)
- **Cron security existant** : `hub-security-cron.yml` (Trivy image quotidien sur deployed) — partiel

### 17. Playwright partiel
- **Tests existants** : `e2e/prod-smoke/` (4 smokes Auth.js + /login)
- **Manque** : `playwright.config.ts` aligné standard (`retries: 2`, `trace: 'retain-on-failure'`)
- **Manque** : `playwright-flaky-detector.yml` (cron hebdo flake_rate)

### 22. `--ignore-scripts` partiel
- **CI audit** : oui (`_audit-cve.yml` ligne 56-63)
- **CI test job** : non (`pnpm install --frozen-lockfile` sans `--ignore-scripts`)
- **Dockerfile** : 🔲 à vérifier

---

## 🚧 SECTION A — Staging éphémère par PR sur dev server (P0 actif)

> **Objectif** : Chaque PR ouverte spawn une stack `hub-<branch-slug>.staging.veridian.site`. Au merge/close → teardown auto. Plus jamais de push prod sans validation visuelle.
> **Spec complète** : CI-ARCHITECTURE.md §9 + §17.3.
> **Architecture compose retenue** : pattern `include:` (Compose 2.20+) avec `compose/base.yml` + `compose/prod.yml` + `compose/staging.yml`. Le `docker-compose.yml` racine est un wrapper minimal qui `include:` base+prod (lu par Dokploy en GitOps). **Validation byte-exact identique au compose monolithique prod précédent**.

### A.1 Pré-requis infra (côté dev server)

- ✅ **DNS wildcard** `*.staging.veridian.site` → `37.187.199.185` (Cloudflare proxy OFF — Robert l'a posé)
- ✅ **Traefik v3 standalone** sur dev (`~/traefik-staging/`, systemd service `traefik-staging.service`, image `traefik:v3.6.17`)
- ✅ Network `staging-edge` créé (external, bridge)
- ✅ Cert wildcard Let's Encrypt DNS-01 (Cloudflare provider, token API)
- ✅ Doc d'usage : `~/traefik-staging/README.md` sur dev (rejoindre `staging-edge` + labels `<app>.staging.veridian.site`)
- 🔲 Créer `/opt/staging/hub/` sur dev (le workflow le fait au premier spawn via `mkdir -p`)
- 🔲 SSH key dédiée `staging-deploy` avec `command=` restriction dans `authorized_keys` (scope `/opt/staging/hub/*` + permission Docker)
- 🔲 Déployer le `staging-gc.sh` (cf scripts/ops/) sur dev + systemd timer hebdo

### A.2 Côté repo `veridian-hub` — ✅ FAIT

- ✅ **Compose modulaire** `compose/base.yml` + `compose/prod.yml` + `compose/staging.yml`
- ✅ **Wrapper Dokploy** `docker-compose.yml` racine = `include: [compose/base.yml, compose/prod.yml]` (byte-exact identique à l'ancien monolithique → zéro risque prod)
- ✅ **Workflow** `.github/workflows/hub-staging.yml`
  - Trigger : `pull_request` types `[opened, synchronize, reopened, closed]` vers `main`
  - Job `spawn` (sur action != closed) : build image staging-<sha7> → push GHCR → SSH dev → SCP compose → `docker compose up` → wait healthy → smoke HTTPS → comment PR
  - Job `teardown` (sur closed) : SSH dev → `docker compose down -v --remove-orphans --timeout 30` → `rm -rf` dossier → `image prune` filtré par label
  - Step `if: always()` cleanup runner GitHub
  - Concurrency par PR (cancel-in-progress)
- ✅ **Script check** `scripts/ci/check-compose-sync.sh` (5 vérifs : YAML valide, base+prod compose, base+staging compose, wrapper include valide, labels Traefik prod corrects)
- ✅ Pre-push hook étendu : appelle aussi `check-compose-sync.sh` si fichier compose modifié dans le diff
- ✅ CI Hub : `check-compose-sync.sh` ajouté en étage 1 dans `hub-ci.yml` (toujours)
- ✅ **GC script** `scripts/ops/staging-gc.sh` (à déployer sur dev sous `/opt/scripts/` + timer systemd)

### A.3 Secrets / Variables GitHub à configurer (BLOQUANT — workflow inutile sinon)

Le workflow `hub-staging.yml` attend ces secrets/vars sur le repo `Christ-Roy/veridian-hub` :

**Secrets** (Settings → Secrets and variables → Actions → Secrets) :
- 🔲 `STAGING_SSH_KEY` — clé privée SSH ed25519 avec accès dev-pub scope staging
- 🔲 `STAGING_HUB_AUTH_SECRET` — secret AUTH.js staging (différent prod, random 32 bytes)
- 🔲 `STAGING_POSTGRES_PASSWORD` — mot de passe DB éphémère (random)

**Variables** (Settings → Secrets and variables → Actions → Variables) :
- 🔲 `STAGING_HOST` — `dev-pub.veridian.site` ou IP publique du dev
- 🔲 `STAGING_USER` — user SSH dédié staging (idéalement pas root, pas `ubuntu` non plus si possible)

### A.4 DB snapshot prod anonymisé (Phase 2, pas P0)

> Pas bloquant pour P0 : staging tourne avec DB Postgres éphémère vide (migrations Prisma au boot). Pour signup + flows applicatifs c'est suffisant. Pour tester avec données réalistes, il faudra la phase 2.

- 🔲 Cron nightly sur prod : `pg_dump` schéma `hub_app` → anonymizer (emails hashés, noms randomisés, cards Stripe en test mode)
- 🔲 Rsync vers `/opt/snapshots/hub-anonymized-latest.sql` sur dev
- 🔲 Script `restore-staging-db.sh` appelé par `staging-ephemeral.yml`
- 🔲 Documenter dans `veridian-infra/runbooks/db-anonymizer.md`

### A.5 Garbage collector — ✅ script prêt, déploiement à faire

- ✅ Script `scripts/ops/staging-gc.sh` (versionné dans le repo Hub)
- 🔲 Copier vers dev sous `/opt/scripts/staging-gc-hub.sh`
- 🔲 Systemd timer hebdomadaire (dimanche 03:00 UTC)
- ✅ Logique : si PR closed ET dossier > 24h → kill ; si gh CLI indispo → fallback âge 7j
- ✅ Alerte Telegram si disk > 80% après GC

---

## 🚧 SECTION B — Hardening sécurité supply chain

> Spec : Constitution §19, §20 + CI-ARCHITECTURE §17.2, §17.3

- 🔲 Ajouter `--ignore-scripts` dans **tous** les `pnpm install` de `hub-ci.yml` (job `test`, job `e2e-prod-smoke`)
- 🔲 Modifier `Dockerfile` : `pnpm install --frozen-lockfile --ignore-scripts`
- 🔲 Ajouter `pnpm.onlyBuiltDependencies` dans `package.json` (whitelist : `husky`, `@playwright/test`, `prisma`, `@prisma/client`)
- 🔲 Ajouter `gitleaks` étage 1 (secret scan en plus de Trivy)
- 🔲 Ajouter cleanup runner `always()` step dans chaque job
- 🔲 Lint workflow YAML custom qui rejette jobs sans cleanup step

---

## 🚧 SECTION C — Migrations DB safety

> Spec : CI-ARCHITECTURE §4

- 🔲 Créer `scripts/ci/check-migration-safety.sh` (bloque `DROP COLUMN`, `RENAME`, `ALTER NOT NULL` sur table existante, `CREATE INDEX` sans `CONCURRENTLY`, `ALTER COLUMN TYPE` destructif)
- 🔲 Câbler en étage 1 sur PR qui touche `prisma/migrations/**`
- 🔲 Créer job `test-backward-compat` étage 2 : pull image `previous`, apply migration de la PR, run smoke fonctionnel
- 🔲 Convention `prisma/migrations/contract/` pour migrations Contract (avec `[contract-phase]` commit message + `VEX-MIGRATION.md`)

---

## 🚧 SECTION D — Auto-rollback + revert Git

> Spec : CI-ARCHITECTURE §17.1, §17.5

- 🔲 Workflow `emergency-revert.yml` (déclenché par `repository_dispatch`)
  - Auto-create branch `auto-revert/<sha>` + revert + PR auto-mergée
  - Freeze main pendant le revert
  - Annotation Grafana `revert` + Telegram alert
- 🔲 PAT `GH_AUTOREVERT_PAT` créé + secret repo
- 🔲 Workflow `emergency-rollback.yml` (déclenché par alertes Grafana via webhook)
- 🔲 Configurer contact point webhook Grafana Cloud → `repository_dispatch`
- 🔲 PAT `GH_ROLLBACK_PAT` côté Grafana
- 🔲 Alertes câblées jour 1 : `oom_killed`, `memory_creep`, `synthetic_failed_3x`
- 🔲 Alertes dormantes documentées : `error_rate_spike`, `latency_p95_doubled` (active si trafic ≥ 100 req/min)

---

## 🚧 SECTION E — Renovate (remplacement Dependabot)

> Spec : Constitution §7 + CI-ARCHITECTURE §10

- 🔲 Créer `.github/renovate.json` standard (extends config:recommended + dependencyDashboard + semanticCommits)
- 🔲 Désactiver Dependabot (`.github/dependabot.yml` → archivé)
- 🔲 Installer GitHub App Renovate sur l'org
- 🔲 Auto-merge rules : patch + minor (≥1.0.0) + CVE → auto si CI verte ET smoke 24h vert
- 🔲 Major + docker bases critiques (postgres/redis/traefik) → label `needs-human-review`

---

## 🚧 SECTION F — Test stack moderne (MSW + happy-dom + RTL)

> Spec : CI-ARCHITECTURE §2

- 🔲 `pnpm add -D @testing-library/react @testing-library/user-event happy-dom msw`
- 🔲 `vitest.config.ts` : `environment: 'happy-dom'` pour `__tests__/components/`
- 🔲 Créer `__tests__/mocks/handlers.ts` + `__tests__/mocks/server.ts` (setup MSW)
- 🔲 Migrer les `vi.mock('fetch')` / `vi.mock('axios')` existants vers handlers MSW
- 🔲 Interdiction `vi.mock('@/lib/api/*')` (lint custom ESLint si possible)

---

## 🚧 SECTION G — Bundle budget

> Spec : Constitution §15

- 🔲 `pnpm add -D size-limit @size-limit/preset-app`
- 🔲 Config `.size-limit.json` ou bloc dans `package.json`
- 🔲 Budgets par chunk : First Load JS baseline + 15% max
- 🔲 Câbler étage 1 dans `hub-ci.yml`

---

## 🚧 SECTION H — Annotations Grafana applicatives

> Spec : CI-ARCHITECTURE §12

- 🔲 Câbler `obs annotate deploy` dans le job `deploy-prod` (après smoke OK)
- 🔲 Câbler `obs annotate migrate` avant + après migration Prisma
- 🔲 Câbler `obs annotate rollback` dans rollback-prod
- 🔲 Câbler `obs annotate renovate` sur merge PR Renovate (post-Section E)
- 🔲 Documenter l'usage `obs events <app>` / `obs diff <app> <sha1> <sha2>`

---

## 🚧 SECTION I — Autonomous CI (humain hors boucle)

> Spec : CI-ARCHITECTURE §13

### Actif jour 1 (indépendant trafic)
- 🔲 Auto-fix avant blocage : `eslint --fix`, `prettier --write`, `pnpm dedupe` + commit `chore: autofix [skip ci]`
- 🔲 Stale branch cleanup : GitHub Settings → branche feature inactive >30j ou merged → suppression auto
- 🔲 Pas de review humaine sur main : Branch Protection → 8 checks requis, **pas de PR review required**
- 🔲 Self-healing crashes : `veridian-docker-monitor` 3 restarts backoff exponentiel avant alerte
- 🔲 Smoke fonctionnel chronométré + auto-rollback si > 2× temps précédent
- 🔲 Synthetic monitoring 5 min sur prod (rejoue smoke depuis dev)

### Couches dormantes (activation ≥100 req/min)
- 🔲 Canary 20% via Traefik weighted routing
- 🔲 Auto-rollback métriques live (error rate, p95, RAM)
- 🔲 Rollback budget (>3 rollbacks/h → freeze 6h)

---

## 📊 KPIs cibles (extrait CI-ARCHITECTURE §16)

| Métrique | Cible | Mesure actuelle |
|---|---|---|
| `tests-pending.txt` | 0 sous 90j | **116** (au 2026-05-14) |
| Durée pipeline complet | < 4 min p95 | À mesurer après PR #17 |
| Taux échec prod deploy (rollback) | < 1 % | À mesurer |
| CVE high+critical en prod | 0 | À mesurer (Trivy cron) |
| Interventions humaines / semaine | 0 | ~5-10/semaine actuellement |

---

## 🔗 Liens

- **Spec** : `~/Bureau/veridian-platform/CI-ARCHITECTURE.md`
- **Constitution CI** : section §14 de CI-ARCHITECTURE.md
- **TODO Hub global** : `todo/apps/hub/TODO.md` (sprint P0 CI mentionné)
- **TODO racine plateforme** : `~/Bureau/veridian-platform/todo/TODO-LIVE.md` (si présent)
- **Memory** : `~/.claude/projects/-home-brunon5-Bureau-veridian-platform/memory/project_ci_standard_v1.md`

---

## 📝 Journal des actions

### 2026-05-14
- ✅ Création de ce fichier `todo/CI-TODO.md`
- ✅ PR #17 ouverte : `fix(dashboard): RSC icon prop crash on /dashboard` (Next 15 RSC serialization bug). Branche `fix/dashboard-rsc-icon-prop`. Validation locale verte (lint + 132 tests + build + audit). Pre-push hook a validé le mapping route↔test.
- ✅ Validé que la CI Hub n'a **pas** de jobs deploy/docker/trivy sur PR feature branches (condition `if: github.ref == 'refs/heads/main' && github.event_name == 'push'` ligne 67, 184, 211 de `hub-ci.yml`). Donc une PR feature ne risque pas la prod.
- ✅ Recon dev server effectuée : 2 runners actifs, Docker actif, Dokploy installé, **PAS de Traefik standalone**, **PAS de `/opt/staging/`**, services systemd `veridian-docker-monitor`/`-system-monitor`/`-prod-healthcheck` OK.
- ✅ **Robert a posé l'infrastructure staging sur dev** : Traefik v3 standalone à `~/traefik-staging/` (systemd `traefik-staging.service`), network `staging-edge`, wildcard DNS `*.staging.veridian.site` → 37.187.199.185, doc d'usage dans `~/traefik-staging/README.md`. Dokploy a été retiré du dev server le 2026-05-14.
- ✅ **Audit prod GitOps Dokploy** : confirmé que le Hub est en mode GitOps (clone `https://github.com/Christ-Roy/veridian-hub.git` branch `main`), HEAD du clone Dokploy = HEAD `main` distant (`0aad0da`), container up depuis 10h healthy, routes 200 partout, 0 erreur réelle dans les logs (sauf bug `/dashboard` connu en PR #17). Prod **OK**.
- ✅ **Refacto compose pattern base + prod + staging** (Option 2 choisie : include wrapper, pas de génération) :
  - `compose/base.yml` (commun image + healthcheck + vars partagées)
  - `compose/prod.yml` (override prod : dokploy-network, app.veridian.site, secrets LIVE)
  - `compose/staging.yml` (override staging : staging-edge, hub-<slug>.staging.veridian.site, postgres éphémère, Stripe TEST)
  - `docker-compose.yml` racine = wrapper `include:` minimal (lu par Dokploy)
  - **Validation byte-exact** : `docker compose config` du wrapper produit le **même runtime byte par byte** que l'ancien compose monolithique → 0 risque de régression prod
- ✅ Script `scripts/ci/check-compose-sync.sh` (5 checks : YAML valide × 3, compose valide prod, compose valide staging, wrapper include cohérent, labels Traefik prod corrects)
- ✅ Pre-push hook étendu pour appeler `check-compose-sync.sh` quand un fichier compose est modifié
- ✅ CI Hub : `check-compose-sync.sh` ajouté en étage 1 de `hub-ci.yml` (toujours)
- ✅ Workflow `.github/workflows/hub-staging.yml` créé (spawn sur PR open/sync, teardown sur PR close, cleanup runner `always()`, commentaire PR avec URL staging)
- ✅ Script `scripts/ops/staging-gc.sh` créé (GC hebdo : kill stacks orphelines, fallback âge 7j si gh CLI indispo, alerte Telegram si disk > 80%)
- ✅ **PR #18 ouverte** : `feat(ci): staging éphémère par PR + refacto compose base/prod/staging` (https://github.com/Christ-Roy/veridian-hub/pull/18)
- ✅ **Runbook d'activation** : `runbooks/activate-staging.md` versionné (user SSH dédié, génération clé ed25519, secrets/vars GitHub, GC + systemd timer, test end-to-end, troubleshooting)
- ✅ **CI Hub `Hub CI/CD` ✅ VERTE** sur PR #18 (test 1m35s + audit 20s, deploy/docker/trivy skipped par condition PR)
- ✅ **CI staging workflow se déclenche** correctement sur la PR (job `spawn` tourne, `teardown` skipping car PR open)

### Bugs CI rencontrés + fixés

1. ❌ **YAML parse fail** : heredoc `<<ENV` imbriqué dans `<<EOF` du run step → parser GitHub Actions refusait le fichier (`could not find expected ':'`).
   - **Fix** : génération `.env` localement sur runner via printf, scp sur dev, rm immédiat. Pas d'heredoc imbriqué.
   - **Leçon** : max 1 niveau d'heredoc dans les blocs `run: |` GitHub Actions.

2. ❌ **Faux succès "Deploy stack ✓"** : le check `[ -z "${{ vars.STAGING_HOST }}" ] && exit 0` rendait silently OK le step quand `STAGING_HOST` était vide. Job entier passait au "vert" sans rien déployer → smoke échouait 60s plus tard sur une URL sans container derrière.
   - **Fix** : exit 1 strict avec liste des secrets manquants dans le step `Setup SSH`. Le workflow tombe rouge immédiatement si secrets pas configurés.
   - **Leçon** : ne **jamais** faire `exit 0` silencieux quand des secrets sont requis. Préférer `exit 1` avec message explicite.

3. ✅ **Image staging push GHCR** : OK (tag `staging-<sha7>`, ex `staging-93c5295`)

### 🎯 Bilan fin de session 2026-05-14

#### PR mergées sur main

- ✅ **PR #17** (`fix/dashboard-rsc-icon-prop`) : fix RSC `/dashboard` Next.js 15. Merge commit `e8526787`. Pipeline complet vert (test + audit + docker + trivy + deploy-prod + e2e-prod-smoke). **Validé visuellement** : `/dashboard` rend correctement, robert.brunon connecté voit les cards Prospection/Notifuse + ServiceCard avec icon BarChart3.
- ✅ **PR #18** (`feat/staging-ephemeral-ci`) : refacto compose base/prod/staging + workflow staging fixe + smoke-prod.sh + runbook activate-staging. Merge commit `babed29a`. Pipeline complet vert. **Validation byte-exact** : compose `include:` produit le même runtime que l'ancien monolithique → 0 régression Dokploy.
- ✅ **PR #19** (`feat/ci-hardening`) : extension CI (anti `--no-verify` étage 1 + supply chain `--ignore-scripts` partout + 🔥 mode Nuclear) + path-based skip étendu (`docs/`, `runbooks/`). Merge commit `b7c95604`. CI test+audit verte avant merge. Pipeline post-merge en cours de surveillance (redeploy Dockerfile hardened).

#### Infrastructure staging activée

- ✅ User SSH `staging-deploy` créé sur dev (groupe docker, /opt/staging/hub/ owner)
- ✅ Clé SSH ed25519 générée localement (`~/credentials/staging-deploy-veridian-hub`) et déployée sur dev
- ✅ Secrets GitHub repo Christ-Roy/veridian-hub : `STAGING_SSH_KEY`, `STAGING_HUB_AUTH_SECRET`, `STAGING_POSTGRES_PASSWORD`
- ✅ Variables GitHub : `STAGING_HOST` (= `37.187.199.185`), `STAGING_USER` (= `staging-deploy`)
- ✅ Workflow staging conforme convention CLAUDE.md racine : `hub.staging.veridian.site` (URL fixe), trigger sur push branche `staging`, pas d'éphémère

#### Bugs CI rencontrés + fixés (Session)

1. ❌ **YAML parse fail** : heredoc `<<ENV` imbriqué dans `<<EOF` du run step → parser GitHub Actions refusait le fichier.
   - Fix : génération `.env` localement via printf + scp + rm.
   - Leçon : max 1 niveau d'heredoc dans `run: |`.

2. ❌ **Faux succès "Deploy stack ✓"** : check `[ -z "$STAGING_HOST" ] && exit 0` rendait OK silently quand secrets vides → job vert, smoke fail 60s plus tard sans container.
   - Fix : conditionner les jobs au niveau YAML `if: vars.STAGING_HOST != ''` → status SKIPPED. Strict check explicite dans step `Setup SSH` (exit 1 avec liste secrets manquants).
   - Leçon : ne **jamais** faire `exit 0` silencieux quand des secrets sont requis.

3. ❌ **`.env` non chargé via SSH subshell** : Compose voyait `BRANCH_SLUG` vide → container nommé `hub-` au lieu de `hub-<slug>`, image `:latest` (prod) au lieu de `staging-<sha7>`.
   - Fix : `--env-file .env` explicite + simplification → URL fixe (plus de slug) selon convention CLAUDE.md.

4. ❌ **Convention initiale incorrecte** : j'avais conçu un staging éphémère par PR avec sous-domaine `hub-<slug>.staging.veridian.site`. La convention officielle Veridian (CLAUDE.md racine §Staging) est `<app>.staging.veridian.site` fixe.
   - Fix : refonte complète (commit `6a598b0`), trigger `push: branches: [staging]` au lieu de `pull_request`. Volume persistant pour la DB staging.

#### 🔥 Mode Nuclear activé (PR #19)

Allowlist `tests-pending.txt` IGNORÉE sur ces scopes :
- `app/api/**/route.ts` (routes API)
- `components/**` sauf `components/ui/**`
- `hooks/**`
- `lib/**` sauf `lib/types/*`

Conséquence : **toute modif de business logic exige son test colocalisé**, même si fichier était en dette historique. `tests-pending.txt` réduit de 116 → 41 entrées (uniquement components/ui).

Garde-fou complet : pre-push hook (local) + check-test-mapping en étage 1 CI (anti `--no-verify`).

### 2026-05-13
- ✅ Standard CI Veridian v1 validé (CI-ARCHITECTURE.md, 1206 lignes)
- ✅ Hub baseline `tests-pending.txt` générée (116 fichiers)
- ✅ Husky pre-push + `check-test-mapping.sh` versionnés et opérationnels
- ✅ `test-coverage-map.yaml` placeholder créé
- ✅ Path-based skip `paths-ignore` câblé dans `hub-ci.yml`
