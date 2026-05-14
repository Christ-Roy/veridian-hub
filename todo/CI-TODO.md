# CI Veridian — TODO dédié

> **Spec de référence** : `~/Bureau/veridian-platform/CI-ARCHITECTURE.md` (1206 lignes, validé 2026-05-13).
> Ce fichier suit l'**implémentation** chantier par chantier — fait / en cours / à faire.
> Mis à jour à chaque action significative sur la CI Hub.

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
| 1. Script de mapping route↔test | ✅ Versionné + exécutable | — |
| 2. Husky pre-push hook | ✅ Installé + actif | — |
| 3. Baseline `tests-pending.txt` | ✅ 116 fichiers critiques listés | — |
| 4. `test-coverage-map.yaml` versionné | ✅ Présent (vide, à peupler au fil de l'eau) | — |
| 5. Path-based skip CI (docs/todo/runbooks) | ✅ `paths-ignore` dans `hub-ci.yml` | — |
| 6. Workflow réutilisable `_app-ci.yml` partagé | 🔲 N'existe pas dans veridian-infra | Mutualisation 5 apps |
| 7. Path-based staging gate (changements structurels) | 🔲 Pas câblé | Promotion auto staging→prod |
| 8. GitHub Environments staging + production | 🔲 Pas créés sur le repo | Approbation manuelle structurel |
| 9. Trivy 9 capacités (vuln/misconfig/secret/license/image/EOL/SBOM/SARIF/cron) | 🟡 Partiel (image scan oui, le reste non) | Conformité Constitution §8 |
| 10. SARIF upload → GitHub Security tab | 🔲 Aucun upload-sarif@v3 | Centralisation findings |
| 11. `.trivyignore.yaml` avec VEX | 🔲 Pas créé | Gestion faux positifs propre |
| 12. Script `check-migration-safety.sh` | 🔲 Pas créé | Migrations destructives non gardées |
| 13. Job `test-backward-compat` (image previous vs schéma N) | 🔲 Pas créé | Auto-rollback peut crasher DB |
| 14. MSW (mock service worker) | 🔲 Pas installé | Tests réseau actuels = `vi.mock` |
| 15. `happy-dom` + RTL + `__tests__/components/` | 🔲 Pas configuré | Component DOM tests |
| 16. `size-limit` (bundle budget +15%) | 🔲 Pas câblé | Bloque Renovate fat-bundle |
| 17. Playwright `retries: 2` + flaky detector | 🟡 Playwright OK, pas de `playwright-flaky-detector.yml` | Flaky → rollback bidon |
| 18. Renovate `renovate.json` (auto-merge total) | 🔲 Pas migré (Dependabot encore actif) | Auto-merge minor/major bloqué |
| 19. **Staging éphémère par PR sur dev server** | 🟡 **Code prêt, manque secrets repo + DNS** — voir §A | Valider sans prod |
| 19a. Compose pattern base + prod + staging (include) | ✅ Refacto fait, byte-exact identique prod | — |
| 19b. Script `check-compose-sync.sh` + pre-push + CI | ✅ Versionné + actif | — |
| 19c. Workflow `hub-staging.yml` (spawn/teardown) | ✅ Versionné, attend secrets | Pas tant que secrets absents |
| 19d. GC hebdo `staging-gc.sh` | 🟡 Script écrit, pas déployé sur dev | Cleanup safety net |
| 20. `emergency-revert.yml` (rollback Docker → revert Git) | 🔲 Pas créé | Commit fautif reste sur main |
| 21. `emergency-rollback.yml` (Grafana webhook → rollback) | 🔲 Pas créé | Alertes Grafana = silence |
| 22. `--ignore-scripts` strict (CI + Dockerfile) | 🟡 CI oui (`_audit-cve.yml`), Dockerfile à vérifier | Supply chain attack |
| 23. `pnpm.onlyBuiltDependencies` whitelist | 🔲 Pas configuré dans `package.json` | Idem supply chain |
| 24. Cleanup runner `always()` step | 🔲 Pas câblé | Runner empoisonné |
| 25. Auto-merge total PR (8 checks + plus de review humaine) | 🔲 Branch protection à configurer | Robert hors boucle |
| 26. `obs annotate` cablé dans étage 3 (deploy/migrate/rollback) | 🔲 Pas câblé | Timeline Grafana incomplète |
| 27. Synthetic monitoring 5 min sur prod | 🔲 Pas câblé | Baseline absente |
| 28. Coverage hooks/lib (`__tests__/hooks/`, `__tests__/lib/`) | 🔲 Pas créé | Mapping script ne couvre que API |

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
- ✅ **Premier push échec CI workflow file YAML** : heredoc `<<ENV` imbriqué dans `<<EOF` du run step → parser GitHub Actions refusait le fichier. Fix : génération `.env` localement sur runner puis scp, pas d'heredoc imbriqué. **Pattern à éviter dans les futurs workflows : un seul niveau d'heredoc max dans les blocs `run: |`.**
- ✅ **Runbook d'activation** : `runbooks/activate-staging.md` versionné (user SSH dédié, génération clé ed25519, secrets/vars GitHub, GC + systemd timer, test end-to-end, troubleshooting)
- 🔲 **Reste à faire pour activer staging** (après merge PR #18) :
  - Configurer secrets/vars GitHub repo (cf `runbooks/activate-staging.md` Étape 4)
  - Créer user SSH `staging-deploy` sur dev + déployer clé publique (Étape 1-3)
  - Déployer `staging-gc.sh` sur dev + systemd timer hebdo (Étape 5)
  - Tester end-to-end avec une PR de test (Étape 6)

### 2026-05-13
- ✅ Standard CI Veridian v1 validé (CI-ARCHITECTURE.md, 1206 lignes)
- ✅ Hub baseline `tests-pending.txt` générée (116 fichiers)
- ✅ Husky pre-push + `check-test-mapping.sh` versionnés et opérationnels
- ✅ `test-coverage-map.yaml` placeholder créé
- ✅ Path-based skip `paths-ignore` câblé dans `hub-ci.yml`
