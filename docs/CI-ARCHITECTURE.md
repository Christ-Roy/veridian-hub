# Architecture CI Veridian — Standard pixel-parfait

> Référence CI/CD pour les 6 apps polyrepo. Règle identique partout, zéro dérive, zéro exception.

---

## 1. Règle d'or — 1 fichier critique = 1 test colocalisé

Mapping strict par convention de chemin, sans marker, sans annotation, sans bypass.

### Scopes critiques et mapping

| Scope | Pattern source | Test attendu | Type de test |
|---|---|---|---|
| Routes API Next.js | `app/api/**/route.ts` | `__tests__/api/<path>.test.ts` | Integration (Vitest + Postgres) |
| Composants React | `components/**/*.tsx` | `__tests__/components/<path>.test.tsx` | DOM (Vitest + RTL + happy-dom) |
| Hooks | `hooks/**/*.ts(x)` | `__tests__/hooks/<path>.test.ts(x)` | renderHook (Vitest) |
| Lib métier | `lib/**/*.ts` (sauf types/) | `__tests__/lib/<path>.test.ts` | Unit pur (Vitest) |
| Handlers Go | `internal/handlers/*.go` | `internal/handlers/*_test.go` | Unit + integration (go test) |
| Schémas DB | `prisma/schema.prisma` | migration dans `prisma/migrations/` + test integration concerné | Integration |

### Pourquoi mapping par chemin et pas par metadata

Aucune annotation dans le code, aucune intelligence requise. Le script fait un `string replace` :
```
app/api/auth/signup/route.ts
  → strip `app/api/` + `/route.ts`
  → préfixer `__tests__/api/` + suffixer `.test.ts`
  → __tests__/api/auth/signup.test.ts
```

Convention applicable même sur le repo le plus crade, **sans refactor préalable**.

### Double enforcement

| Couche | Outil | Rôle |
|---|---|---|
| Local | Husky `pre-push` | Refuse push si fichier critique modifié sans test colocalisé modifié |
| CI | Job `test-mapping` étage 1 | Même script rejoué, attrape Renovate/PRs externes |

Script unique partagé : `scripts/ci/check-test-mapping.sh` dans `veridian-infra`, sourcé par chaque repo. Zéro duplication.

### Allowlist transitoire (zéro refactor)

`tests-pending.txt` à la racine de chaque app — fichiers critiques EXISTANTS sans test. Baseline générée automatiquement le jour de l'install :
```bash
# Génération initiale (une seule fois par app)
find app/api -name 'route.ts' >> tests-pending.txt
find components -name '*.tsx' >> tests-pending.txt
# etc. pour chaque scope
```

Le hook laisse passer les fichiers en allowlist. Bloque uniquement :
- Tout **nouveau** fichier critique sans test
- Toute modif d'un fichier hors allowlist sans test
- Toute ligne retirée de `tests-pending.txt` doit s'accompagner du test correspondant

Cron hebdo `wc -l tests-pending.txt` → issue GitHub auto. **Cible : 0 sous 90 jours**, dette se résorbe au fil des PRs.

### Coverage map — éliminer les faux tests vides

Angle mort du mapping pur par chemin : un fichier critique peut être **légitimement couvert par un test ailleurs** (ex : `lib/billing.ts` couvert par `__tests__/api/payment.test.ts` qui exerce tout le flux de paiement).

Solution : `test-coverage-map.yaml` versionné à la racine de chaque app, déclare explicitement les couvertures non-canoniques :

```yaml
# test-coverage-map.yaml
# Chaque entrée déclare quels fichiers sont couverts par quel(s) test(s)
- sources:
    - lib/billing.ts
    - lib/stripe-helpers.ts
  covered_by:
    - __tests__/api/payment.test.ts
  reason: |
    Le module billing n'a pas de test unitaire isolé car toutes ses fonctions
    sont exercées de bout en bout par les tests d'intégration Stripe.

- sources:
    - lib/auth/jwt.ts
  covered_by:
    - __tests__/api/auth/login.test.ts
    - __tests__/api/auth/refresh.test.ts
  reason: JWT helpers couverts par les tests d'integration auth complets.
```

Le hook `check-test-mapping.sh` :
1. Fichier critique modifié → cherche d'abord `__tests__/<path>.test.ts` (mapping canonique)
2. Si absent → cherche dans `test-coverage-map.yaml` la couverture déclarée
3. Si déclaré → exige qu'**au moins un** des `covered_by` soit modifié dans la même PR
4. Si aucun match → push refusé

**Pas de `[skip-test-mapping]` en commit message** (trop facile à abuser). La coverage map est versionnée, reviewable, et oblige à écrire **pourquoi** ce test couvre ce fichier. Renovate/agents ne peuvent pas l'ajouter sans toucher la map.

### Interdiction bypass

`--no-verify` interdit (commit et push). Inscrit dans Constitution CI (CLAUDE.md racine). Si hook bloque, on ajoute le test, on ne contourne pas.

---

## 2. Pyramide de tests Veridian

```
   ┌────────────────────────────────────────────────────────────┐
   │  E2E Playwright                  ~10/app    étage 2        │
   │  Parcours critiques (signup → checkout → use feature)      │
   │  Self-hosted, navigateurs préinstallés, 30 s–2 min         │
   ├────────────────────────────────────────────────────────────┤
   │  Integration API                 ~30/app    étage 2        │
   │  Route + DB réelle via testcontainers Postgres             │
   │  Vitest, ~1 min total                                      │
   ├────────────────────────────────────────────────────────────┤
   │  Component DOM                   ~100/app   étage 1        │
   │  Vitest + @testing-library/react + happy-dom               │
   │  3-5× plus rapide que jsdom, 8-15 s total                  │
   ├────────────────────────────────────────────────────────────┤
   │  Unit pures                      ~300/app   étage 1        │
   │  Helpers, formatters, validators, business logic           │
   │  Vitest pur sans DOM, ~3 s total                           │
   └────────────────────────────────────────────────────────────┘
```

### Stack obligatoire par couche

| Couche | Runner | Outil DOM | Mocking réseau | Stack |
|---|---|---|---|---|
| Unit pures | Vitest | aucun | **MSW** si fetch | `vitest`, `msw` |
| Component DOM | Vitest | **happy-dom** (pas jsdom) | **MSW** obligatoire | `vitest`, `@testing-library/react`, `@testing-library/user-event`, `happy-dom`, `msw` |
| Integration API | Vitest | aucun | Pas de mock (DB réelle) | `vitest`, `@testcontainers/postgresql` |
| E2E | Playwright | navigateur réel | Pas de mock (env réel) | `@playwright/test` |

`happy-dom` choisi pour sa vitesse — 3 à 5× plus rapide que jsdom sur les workloads React Veridian, et 100 % compatible avec RTL.

### MSW (Mock Service Worker) — règle absolue

**Interdiction de `vi.mock('fetch')`, `vi.mock('axios')`, `vi.mock('@/lib/api/*')` sur la couche réseau.**

Toujours MSW handlers, déclarés dans `__tests__/mocks/handlers.ts` :

```ts
// __tests__/mocks/handlers.ts
import { http, HttpResponse } from 'msw'

export const handlers = [
  http.post('/api/auth/signup', async ({ request }) => {
    const body = await request.json()
    if (body.email === 'taken@example.com') {
      return HttpResponse.json({ error: 'EMAIL_TAKEN' }, { status: 409 })
    }
    return HttpResponse.json({ id: 'user-123' }, { status: 201 })
  }),
]
```

Bénéfice : les tests testent le **vrai parcours d'appel réseau** (fetch → request → response → parsing), pas un mock JS qui ment sur les types/contrats.

### Anti-flakiness Playwright — critique pour autonomie CI

Avec auto-rollback sans humain, un test E2E flaky = rollback inutile = perte de temps.

**Configuration `playwright.config.ts` imposée :**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  retries: process.env.CI ? 2 : 0,        // 3 tentatives max en CI
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'playwright-results.json' }],  // pour flaky detection
  ],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',           // trace zip auto pour debug
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
```

**Détection automatique des tests flaky :**

Job CI scheduled hebdo `playwright-flaky-detector.yml` :
1. Lit les résultats des 100 derniers runs (artifacts `playwright-results.json`)
2. Pour chaque test : calcule `flake_rate = (passed_after_retry / total_runs)`
3. Si `flake_rate > 5%` sur 7 jours glissants :
   - Marque le test avec `test.fixme()` auto via PR auto
   - Crée une issue GitHub `flaky-test: <name>` avec stack traces des 5 derniers échecs
   - Annotation Grafana tag `flaky-detected`
   - Le test passe en quarantaine : il continue de tourner mais **ne bloque plus la CI**
4. Quand le test est fixé (`flake_rate < 1%` sur 7j post-fix) → retour en chemin critique auto

**Règle absolue : aucun test E2E ne déclenche un rollback prod tant qu'il n'a pas échoué 3 fois.**

### Convention de fichier component DOM

```ts
// __tests__/components/SignupForm.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SignupForm } from '@/components/SignupForm'

test('affiche erreur si email invalide', async () => {
  render(<SignupForm />)
  await userEvent.type(screen.getByLabelText(/email/i), 'invalid')
  await userEvent.click(screen.getByRole('button', { name: /s'inscrire/i }))
  expect(await screen.findByText(/email invalide/i)).toBeInTheDocument()
})
```

Règle : **un seul test par comportement observable**. Pas de test d'implémentation, pas de snapshot inutile.

---

## 3. Pipeline 3 étages

```
┌─────────────────────────────────────────────────────────────────────┐
│ ÉTAGE 1 — Quick checks       ubuntu-latest        ~60 s             │
├─────────────────────────────────────────────────────────────────────┤
│ • paths-ignore : *.md, docs/, runbooks/, todo/                      │
│ • pnpm install --frozen-lockfile --ignore-scripts (supply chain)    │
│ • lint (eslint --quiet) + typecheck (tsc --noEmit)                  │
│ • test-mapping (script partagé, scopes routes/components/hooks/lib) │
│ • unit pures (vitest, sans DOM)              ~3 s                   │
│ • component DOM (vitest + RTL + happy-dom + MSW)  ~10 s             │
│ • bundle-size check (size-limit, budgets par chunk)                 │
│   → CI rouge si First Load JS dépasse +15 % baseline                │
│ • audit CVE (npm audit / govulncheck) — high+critical bloquant      │
│ • Trivy multi-scan (vuln + misconfig + secret + license)            │
│   → SARIF uploadé vers GitHub Security tab                          │
│ • gitleaks (secrets dans diff Git — complète secret scan binaire)   │
└────────────────────────┬────────────────────────────────────────────┘
                         │ green
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ÉTAGE 2 — Build & integration   self-hosted dev    ~2 min           │
├─────────────────────────────────────────────────────────────────────┤
│ • integration tests (Vitest + Postgres réel via testcontainers)     │
│ • docker build multi-stage (cache BuildKit local dev)               │
│ • Trivy image scan + EOL distro check (--exit-on-eol)               │
│ • Trivy SBOM CycloneDX → artifact GitHub                            │
│ • SARIF image scan → GitHub Security tab                            │
│ • push image GHCR (tag = sha court + branche)                       │
└────────────────────────┬────────────────────────────────────────────┘
                         │ green
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ÉTAGE 3 — Deploy            GitHub Environments + SSH               │
├─────────────────────────────────────────────────────────────────────┤
│ branche staging  → env: staging                                     │
│   → SSH dev-pub : docker compose pull && up -d <app>                │
│   → smoke Playwright API mode (30 s) sur <app>.dev.veridian.site    │
│                                                                     │
│ branche main     → env: production                                  │
│   → manual approval si changement structurel                        │
│   → SSH prod-pub : docker compose pull && up -d <app>               │
│   → smoke prod + rollback auto (tag previous) si fail               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Migrations DB — Expand & Contract obligatoire

🚨 **Le piège mortel du rollback auto** : auto-rollback Docker ne rollback **PAS** la base de données. Si la migration déployée a fait `DROP COLUMN` ou `ALTER COLUMN ... SET NOT NULL`, l'ancienne image redéployée ne comprend plus le schéma → crash total prod.

Avec auto-rollback sans humain dans la boucle, **toute migration non-rétrocompatible est une bombe à retardement**. Solution : **Expand & Contract** imposé par script CI.

### Le pattern Expand & Contract

| Phase | Action | Quand |
|---|---|---|
| **Expand** | Migration **additive only** : ADD COLUMN nullable, CREATE TABLE, CREATE INDEX CONCURRENTLY | Deploy N |
| **Migrate code** | Le code N+1 écrit dans l'ancienne ET la nouvelle colonne (dual-write), lit l'ancienne en fallback | Deploy N+1 |
| **Backfill** | Script idempotent qui peuple la nouvelle colonne pour les rows existantes | Job one-shot post-deploy N+1 |
| **Switch read** | Code N+2 lit la nouvelle colonne, écrit toujours les deux | Deploy N+2 |
| **Contract** | Migration `DROP COLUMN` / `ALTER NOT NULL` sur l'ancienne | Deploy N+3, seulement quand on est certain que N+1 ne tourne plus nulle part |

**Le tag Docker `previous` doit TOUJOURS pouvoir tourner sur le schéma actuel.** Cette règle élimine la classe entière de désastres "auto-rollback qui crash la prod".

### Patterns interdits — bloqués automatiquement par CI

Script CI `scripts/ci/check-migration-safety.sh` exécuté étage 1 sur chaque PR qui touche `prisma/migrations/**` :

| Pattern | Action |
|---|---|
| `DROP COLUMN` | Bloqué sauf si fichier dans `prisma/migrations/contract/` ET commit message contient `[contract-phase]` ET le PR a un fichier `VEX-MIGRATION.md` qui prouve que N-1 n'existe plus |
| `DROP TABLE` | Bloqué sauf même conditions que ci-dessus |
| `ALTER COLUMN ... SET NOT NULL` sur table existante | Bloqué — exige migration 2 phases (ajouter colonne nullable + backfill + alter NOT NULL en contract) |
| `RENAME COLUMN` / `RENAME TABLE` | Bloqué — exige pattern create new + dual-write + drop old |
| `CREATE INDEX` sans `CONCURRENTLY` (Postgres) | Bloqué — verrouille la table en prod |
| `ALTER COLUMN ... TYPE` (cast destructif) | Bloqué — exige ADD COLUMN nouveau type + backfill + drop ancien |

### Test de rétrocompatibilité automatique

Job CI étage 2 obligatoire `test-backward-compat` :

1. Pull l'image Docker `previous` (tag N-1)
2. Apply la migration de la PR (schéma devient N)
3. Lance le container `previous` contre la DB en schéma N
4. Smoke test fonctionnel passe ? → migration safe
5. Smoke test échoue ? → CI rouge, migration **rejetée**

C'est le filet ultime : même si le script statique laisse passer un cas tordu, ce test réel le détectera.

### Coordination avec Renovate

Renovate peut auto-merge des bumps Prisma (lib), pas des migrations elles-mêmes (générées par devs/agents). Les agents qui génèrent une migration doivent :

1. Toujours écrire en mode **Expand** (sinon le script bloque)
2. Si une feature exige un Contract (drop column par exemple), ouvrir **2 PRs séparées** étalées sur au moins 2 deploys distincts
3. Inclure le test de rétrocompatibilité dans la PR Expand (vérifie que le code N-1 tourne sur schéma N)

---

## 5. Trivy — 9 capacités exploitées

Trivy v0.58 est utilisé bien au-delà du simple "scan d'image". On exploite **9 capacités distinctes** réparties sur les étages 1, 2 et un cron hebdo.

### Tableau des capacités

| # | Capacité | Étage | Commande clé | Bloquant ? |
|---|---|---|---|---|
| 1 | **FS scan (CVE deps)** | 1 | `trivy fs --scanners vuln .` | CRITICAL+HIGH |
| 2 | **Config scan (IaC)** | 1 | `trivy fs --scanners misconfig .` | HIGH (Dockerfile user root, secrets clairs, ports exposés) |
| 3 | **Secret scan (code + binaries)** | 1 | `trivy fs --scanners secret .` | Tout secret détecté |
| 4 | **License scan** | 1 | `trivy fs --scanners license .` | GPL/AGPL bloqués (incompat SaaS proprio) |
| 5 | **Image scan (CVE OS + langs)** | 2 | `trivy image --ignore-unfixed <img>` | CRITICAL+HIGH |
| 6 | **EOL distro check** | 2 | `trivy image --exit-on-eol 1 <img>` | Bloque si Alpine/Debian/Ubuntu EOL |
| 7 | **SBOM CycloneDX** | 2 | `trivy image --format cyclonedx -o sbom.json` | Non bloquant, artifact uploadé |
| 8 | **SARIF → GitHub Security tab** | 1 + 2 | `--format sarif` → `upload-sarif@v3` | Centralise tous les findings dans onglet Security du repo |
| 9 | **Cron hebdo prod running** | scheduled | `trivy image` sur toutes les images de `docker ps` | Notification Telegram + annotation Grafana |

### Flags partagés

```bash
trivy \
  --scanners vuln,secret,misconfig,license \   # capacités 1-4 en un seul run
  --severity CRITICAL,HIGH \                    # noise floor
  --ignore-unfixed \                            # ignore les CVE sans patch dispo
  --exit-code 1 \                               # CI rouge si finding
  --format sarif \                              # capacité 8
  --output trivy.sarif \
  fs|image|repo <target>
```

### VEX — gestion des faux positifs

CVE indirecte non exploitable dans notre contexte (ex : CVE sur un parser XML qu'on n'appelle jamais) ?

- Pas de `.trivyignore` aveugle.
- Fichier `.trivyignore.yaml` versionné avec **justification VEX écrite par CVE** :

```yaml
- id: CVE-2024-12345
  statement: not_affected
  justification: vulnerable_code_not_in_execute_path
  impact: Le parser XML vulnérable est importé transitively par lib X
          mais n'est jamais appelé dans notre flow Y.
  reviewed_by: robert.brunon@veridian.site
  reviewed_at: 2026-05-13
```

Trivy honore `--vex .trivyignore.yaml` natif depuis v0.55.

### Caching

- Trivy DB cached dans GHCR sous `ghcr.io/christ-roy/trivy-db:latest` (refresh quotidien via cron). Évite le rate-limit GitHub sur la DB officielle.
- Version Trivy pinnée : `aquasec/trivy:0.58.0`.

### GitHub Security tab — centralisation

Tous les SARIF (étage 1 FS + config + secret + license, étage 2 image, cron hebdo) sont uploadés via `github/codeql-action/upload-sarif@v3`. Résultat :

- **Onglet Security de chaque repo** = vue unifiée de tous les findings
- **Auto-dismiss** des findings fixés (Trivy ne les retrouve plus = GitHub les marque résolus)
- **Auto-create** des Dependabot alerts sur les CVE deps (déjà géré par Renovate de notre côté, GitHub agit en doublon de cross-check)
- Gratuit, natif GitHub, aucune infra à monter

---

## 6. Path-based gates

Skip docs-only :
```yaml
on:
  push:
    paths-ignore:
      - '**.md'
      - 'docs/**'
      - 'runbooks/**'
      - 'todo/**'
```

Changement structurel → staging obligatoire :
```yaml
filters:
  structural:
    - 'Dockerfile'
    - 'docker-compose*.yml'
    - 'prisma/schema.prisma'
    - 'prisma/migrations/**'
    - 'package.json'
    - 'go.mod'
```

Si `structural == true` sur PR vers `main` : commit identique mergé dans `staging` depuis < 24 h + manual approval via GitHub Environment `production`.

---

## 7. Branches & protection

| Branche | Rôle | Protection |
|---|---|---|
| `main` | Production | 8 checks requis (lint, tsc, unit, route↔test, audit CVE, Trivy FS, Trivy config, Trivy image) + PR review + no force-push + linear history |
| `staging` | Staging persistante | Push direct OK, auto-deploy `<app>.dev.veridian.site` |
| `feat/*`, `fix/*` | Feature branches | Aucune, mergent via PR |

---

## 8. Attribution runners

| Job | Runner | Pourquoi |
|---|---|---|
| Lint, tsc, unit, audit, route↔test, Trivy FS+config, gitleaks, size-limit | `ubuntu-latest` | Léger, gratuit, parallèle |
| Integration Postgres, docker build, Trivy image | `self-hosted [dev, <app>]` | Cache layers BuildKit local |
| E2E Playwright | `self-hosted [dev, <app>]` | Navigateurs préinstallés |
| Deploy webhook Dokploy | `ubuntu-latest` | Juste un curl, endpoint public, pas de réseau privé requis |

Scope : 1 runner dev server, 1 label par app (`runs-on: [self-hosted, hub]`). Crash isolé à 1 app.

### Cleanup obligatoire post-job (anti-empoisonnement cache)

Tout job self-hosted **doit** terminer par un step `always()` qui nettoie le runner (cf. §17.3) :

```yaml
- name: Cleanup runner (always)
  if: always()
  run: |
    docker container prune -f
    docker image prune -f --filter "until=1h"
    docker volume prune -f --filter "label!=keep=true"
    docker buildx prune -f --keep-storage 10GB --filter "until=168h"
    sudo rm -rf /tmp/runner-${{ github.run_id }}-*
    df -h / | awk 'NR==2 {if ($5+0 > 80) exit 1}' \
      || ./scripts/notify-telegram.sh "⚠ Runner $(hostname) à $(df -h / | awk 'NR==2 {print $5}')"
```

Hard rule : sans ce step, le job est **rejeté par CI** (lint custom du workflow YAML).

---

## 9. Infrastructure dev server (staging)

Le **dev server OVH** (`dev-pub` → 37.187.199.185, 7.6Gi RAM, 72G disk) héberge **tous les environnements staging** des 5 apps.

### Stack actuelle (post-atomisation 2026-05-13)

| Composant | Statut | Rôle |
|---|---|---|
| Docker Engine | ✓ actif | Runtime containers |
| GitHub Actions Runners (×2) | ✓ actifs | Build/test self-hosted (`veridian-dev-server`, `veridian-dev-server-notifuse`) |
| Alloy (systemd) | ✓ actif | Collecteur logs/metrics → Grafana Cloud |
| `veridian-prod-healthcheck` (systemd) | ✓ actif | Monitoring remote de la prod |
| `veridian-system-monitor` (systemd) | ✓ actif | CPU/RAM/Disk → Telegram alerts |
| Dokploy | ❌ **PAS installé** sur dev (uniquement prod) | — |
| Traefik | ❌ **PAS encore** déployé sur dev | À installer pour router staging |

### Décision : Traefik standalone, pas Dokploy

**Choix** : sur dev, on n'installe **PAS** Dokploy. À la place :
- **Traefik v3 standalone** (compose dédié `infra/dev-traefik/`)
- **Docker Compose pur** par app de staging (compose versionné dans chaque repo `docker-compose.dev.yml`)
- **Deploy par SSH** depuis runner self-hosted ou via webhook GitHub Actions

**Pourquoi** :
- Pas de double maintenance Dokploy (prod uniquement, simple à patcher)
- Compose versionné dans chaque repo = source de vérité unique
- Moins d'overhead RAM sur dev (~500 MB économisés vs Dokploy + son Postgres)
- Cohérent avec workflow GitOps : push → CI → compose pull + up -d via SSH

### Branche `staging` → auto-deploy dev

| App | URL staging | Compose source |
|---|---|---|
| Hub | `https://hub.dev.veridian.site` | `veridian-hub/docker-compose.dev.yml` |
| Prospection | `https://prospection.dev.veridian.site` | `veridian-prospection/docker-compose.dev.yml` |
| Analytics | `https://analytics.dev.veridian.site` | `veridian-analytics/docker-compose.dev.yml` |
| CMS | `https://cms.dev.veridian.site` | `veridian-cms/docker-compose.dev.yml` |
| Notifuse | `https://notifuse.dev.veridian.site` | `notifuse-veridian/docker-compose.dev.yml` |

### Flow staging deploy

1. Push sur branche `staging` → étages 1+2 normaux
2. Étage 3 staging : SSH `dev-pub` depuis runner self-hosted (même réseau, pas besoin de webhook)
3. `cd /opt/staging/<app> && docker compose pull && docker compose up -d`
4. Smoke Playwright API mode sur `https://<app>.dev.veridian.site`
5. Si KO : `docker compose up -d` avec tag `previous` + annotation Grafana

### Ephemeral staging per branch — full CI control

Avec Docker Compose pur (pas Dokploy), la CI **contrôle entièrement le lifecycle** des stacks staging. Pattern imposé :

```
/opt/staging/<app>/                  → branche `staging`, persistante (HEAD)
/opt/staging/<app>-<branch-slug>/    → branches feature, éphémères, rasées au close PR
```

Chaque branche feature spawn sa propre stack avec son URL dédiée :

| Branche | URL staging | Cycle de vie |
|---|---|---|
| `staging` | `https://hub.dev.veridian.site` | Persistante, suit `staging` HEAD |
| `feat/billing-fix` | `https://hub-feat-billing-fix.dev.veridian.site` | Spawn à l'open PR, kill au merge/close |
| `fix/auth-bug` | `https://hub-fix-auth-bug.dev.veridian.site` | Idem |

**Conséquence** : zéro accumulation sur dev. Plus de cruft, plus de "ah il y a 12 stacks orphelines depuis novembre".

### Workflow `staging-ephemeral.yml`

```yaml
name: Ephemeral Staging
on:
  pull_request:
    types: [opened, synchronize, closed]

jobs:
  spawn:
    if: github.event.action != 'closed'
    runs-on: [self-hosted, dev, <app>]
    steps:
      # ... build étage 2 normal
      - name: Deploy ephemeral stack
        run: |
          BRANCH_SLUG=$(echo "${{ github.head_ref }}" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
          STACK_DIR=/opt/staging/${{ inputs.app }}-${BRANCH_SLUG}
          mkdir -p $STACK_DIR
          # Render compose avec URL unique
          envsubst < docker-compose.dev.template.yml > $STACK_DIR/docker-compose.yml
          cd $STACK_DIR
          docker compose pull
          docker compose up -d
      - name: Smoke + annotate
        run: |
          ./scripts/smoke.sh https://${APP}-${BRANCH_SLUG}.dev.veridian.site
          obs annotate deploy --app ${APP} --env staging-ephemeral --branch ${BRANCH_SLUG}

  teardown:
    if: github.event.action == 'closed'
    runs-on: [self-hosted, dev, <app>]
    steps:
      - name: Raser la stack éphémère
        run: |
          BRANCH_SLUG=$(echo "${{ github.head_ref }}" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
          STACK_DIR=/opt/staging/${{ inputs.app }}-${BRANCH_SLUG}
          if [ -d $STACK_DIR ]; then
            cd $STACK_DIR && docker compose down -v --remove-orphans
            rm -rf $STACK_DIR
          fi
          docker image prune -f --filter "label=app=${APP}-${BRANCH_SLUG}"
          obs annotate teardown --app ${APP} --env staging-ephemeral --branch ${BRANCH_SLUG}
```

### Reset DB scripté à chaque deploy staging `main`

Pour la branche `staging` persistante, on peut **reset la DB à chaque deploy** avec un snapshot prod anonymisé :

```yaml
- name: Reset staging DB depuis snapshot prod anonymisé
  run: |
    ssh dev-pub <<EOF
      cd /opt/staging/${APP}
      docker compose down ${APP}-db
      docker volume rm staging-${APP}-pgdata
      docker compose up -d ${APP}-db
      sleep 5
      docker compose exec -T ${APP}-db psql -U postgres -d ${APP} \
        < /opt/snapshots/${APP}-anonymized-latest.sql
    EOF
```

Snapshot anonymisé généré chaque nuit par cron sur prod (emails hash, noms randomisés, cards Stripe en test mode).

### Garbage collector hebdo

Cron du dimanche soir, supprime les stacks éphémères orphelines (PR closes depuis > 7j sans cleanup) :

```bash
#!/bin/bash
# /opt/scripts/staging-gc.sh — exécuté par cron systemd hebdomadaire
ssh dev-pub <<'EOF'
  for dir in /opt/staging/*-*; do
    branch=$(basename $dir | sed 's/^[^-]*-//')
    # Vérifier si la PR existe encore et est ouverte
    if ! gh pr list --head $branch --state open --json number | grep -q number; then
      cd $dir && docker compose down -v --remove-orphans
      cd / && rm -rf $dir
      echo "GC: $dir"
    fi
  done
  docker image prune -af --filter "until=168h"
  docker volume prune -f --filter "label!=keep=true"
EOF
```

### Sprint infra à venir (P0 — bloque le pipeline complet)

- [ ] Session infra dédiée pour poser Traefik v3 standalone sur dev (config minimale, certs Let's Encrypt + wildcard `*.dev.veridian.site`)
- [ ] DNS wildcard `*.dev.veridian.site` → 37.187.199.185 (Cloudflare proxy off pour Let's Encrypt DNS-01)
- [ ] Compose `infra/dev-traefik/docker-compose.yml` versionné dans `veridian-infra`
- [ ] Créer `/opt/staging/` + templates compose par app
- [ ] Script de génération `docker-compose.dev.template.yml` avec `envsubst` (variables `${APP}`, `${BRANCH_SLUG}`)
- [ ] 5 SSH keys runners avec restriction `command=` (1 par app, scoped à `/opt/staging/<app>*`)
- [ ] Snapshots prod anonymisés (cron nightly + script anonymizer dans `veridian-infra/scripts/`)
- [ ] Cron hebdo `staging-gc.sh` (systemd timer)
- [ ] Alloy datasource Docker sur dev (déjà actif sur prod) pour scraper logs staging
- [ ] Documenter dans `veridian-infra/runbooks/dev-server-staging.md`

**Une session infra dédiée sera nécessaire** pour poser cette base. C'est le **prérequis** pour activer le pipeline 3 étages complet sur les 5 apps + débloquer les staging éphémères par PR.

---

## 10. Deploy production — Webhook Dokploy API (endpoint public ouvert)

**Setup actuel** : depuis 2026-05-13, l'endpoint `https://dokploy.veridian.site/api/compose.deploy` est ouvert sur le public via Traefik, protégé par Bearer token (`DOKPLOY_API_KEY` dans GitHub Secrets). Le reste de Dokploy reste Tailscale-only.

### Flow deploy

1. Build + push image GHCR depuis runner self-hosted étage 2
2. Étage 3 (ubuntu-latest) : `curl POST https://dokploy.veridian.site/api/compose.deploy` avec `composeId` + Bearer
3. Dokploy pull la nouvelle image GHCR + redéploie le compose
4. Smoke HTTP sur URL publique (Playwright API mode)
5. Si smoke KO :
   - `curl POST .../api/compose.update` avec l'ancien tag image
   - `curl POST .../api/compose.deploy` à nouveau (rollback)
   - Trigger `emergency-revert.yml` (cf. §17.1)

### Avantages vs SSH

- **Pas de clé SSH à rotater** sur chaque runner
- **Étage 3 sur ubuntu-latest** (pas besoin de runner self-hosted pour deploy, juste curl)
- **Surface d'attaque réduite** à 1 POST scopé sur 1 endpoint Bearer-protégé
- **Cohérent avec l'archi Dokploy** (API officielle, pas de bash custom)
- **Logs deploy centralisés** côté Dokploy (visible dans UI + API `compose.logs`)

### Sécurité

- Token rotaté tous les 6 mois (cron rappel GitHub Issue)
- Endpoint `/api/compose.deploy` whitelisté Traefik par IP GitHub Actions (mise à jour mensuelle via `https://api.github.com/meta`)
- Tous les autres endpoints `/api/*` restent **Tailscale-only** (UI Dokploy, gestion users, etc.)
- Log audit : chaque appel API loggé dans Loki via Alloy

### Composes IDs

| App | composeId Dokploy |
|---|---|
| Hub | (à documenter, voir memory `session_2026-05-13_*`) |
| Prospection | (idem) |
| Analytics | (idem) |
| CMS | `275o-9E3ZWWi0X32wY8hM` (cf. `session_2026-05-13_cms_extraction_gitops`) |
| Notifuse | (cf. `session_2026-05-13_notifuse_gitops_extraction`) |

---

## 10. Renovate (pas Dependabot)

**Choix : Renovate, pas Dependabot.** Auto-merge natif, grouping intelligent, support monorepo et docker-compose, dashboard PR centralisé.

`.github/renovate.json` standard, identique partout :

```json
{
  "extends": ["config:recommended", ":dependencyDashboard", ":semanticCommits"],
  "schedule": ["before 6am on monday"],
  "timezone": "Europe/Paris",
  "packageRules": [
    {
      "matchUpdateTypes": ["patch"],
      "automerge": true,
      "automergeType": "branch"
    },
    {
      "matchUpdateTypes": ["minor"],
      "matchCurrentVersion": "!/^0/",
      "automerge": true,
      "automergeType": "pr"
    },
    {
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "addLabels": ["needs-human-review"]
    },
    {
      "matchDatasources": ["docker"],
      "matchPackagePatterns": ["postgres", "redis", "traefik"],
      "automerge": false
    }
  ],
  "vulnerabilityAlerts": {
    "enabled": true,
    "automerge": true,
    "labels": ["security"]
  },
  "lockFileMaintenance": {
    "enabled": true,
    "schedule": ["before 6am on monday"]
  }
}
```

**Règles auto-merge :**
- Patch (npm/gomod/docker-actions) → auto-merge si CI verte
- Minor stable (≥ 1.0.0) → auto-merge si CI verte
- Major → review humaine obligatoire (label `needs-human-review`)
- Docker base images critiques (postgres, redis, traefik) → review humaine (risque migration data)
- CVE patches → auto-merge prioritaire si CI verte

---

## 11. Workflow réutilisable partagé

Hébergé dans `veridian-infra/.github/workflows/_app-ci.yml` (le repo infra existe déjà, pas besoin de créer un repo dédié).

```yaml
# .github/workflows/_app-ci.yml — squelette pour Hub, Prospection, Analytics, CMS
name: App CI (reusable)
on:
  workflow_call:
    inputs:
      app-name: { required: true, type: string }
      node-version: { required: false, type: string, default: '22' }
      has-db: { required: false, type: boolean, default: true }
    secrets:
      GHCR_TOKEN: { required: true }
      SSH_KEY: { required: true }

jobs:
  quick-checks: ...        # étage 1
  integration-and-build: ... # étage 2
  deploy-staging: ...      # étage 3 staging
  deploy-prod: ...         # étage 3 prod
```

Chaque app appelle :
```yaml
# .github/workflows/ci.yml dans chaque app
jobs:
  call-shared:
    uses: Christ-Roy/veridian-infra/.github/workflows/_app-ci.yml@main
    with:
      app-name: hub
    secrets: inherit
```

**Notifuse (Go) a son propre workflow** `_app-ci-go.yml` — toolchain Go + govulncheck + go test, mais mêmes étages et mêmes Trivy.

---

## 12. Annotations Grafana — timeline applicative

Chaque event structurant pousse une **annotation Grafana Cloud** via `POST /api/annotations` (Bearer SA token, pas de VPN, endpoint public).

Events à annoter depuis la CI :

| Event | Quand | Tags |
|---|---|---|
| `deploy` | Étage 3, après smoke OK | `app:<name>`, `env:<staging\|prod>`, `sha:<short>`, `version:<tag>` |
| `migrate` | Avant + après migration Prisma / Go | `app:<name>`, `env:<env>`, `migration:<name>` |
| `rollback` | Auto-rollback si smoke fail | `app:<name>`, `env:<env>`, `from:<sha>`, `to:<sha>` |
| `renovate` | Merge PR Renovate sur `main` | `app:<name>`, `pkg:<name>`, `bump:<patch\|minor\|major>` |

Exposé via le CLI `obs` existant :
- `obs annotate deploy <app> --env <env> --sha <sha> --version <v>` — push annotation (utilisé par la CI)
- `obs events <app> --since 7d` — timeline d'une app
- `obs diff <app> <sha1> <sha2>` — tous les events entre 2 deploys (outil clé pour bisect d'incident)

Bénéfice : sur n'importe quel dashboard Grafana (latence, RAM, error rate), les lignes verticales marquent "hub v3.2.1 — 09:23" → identification visuelle immédiate du deploy fautif. Un agent debug "X est lent depuis hier" tape `obs events X --since 24h` et trouve le commit suspect en 1 commande, sans ouvrir l'UI Grafana.

---

## 13. Autonomous CI by design — humain hors boucle

Objectif : la CI tranche seule. Robert n'est pas dans le flow.

### 11.1 Actif maintenant (indépendant du trafic)

| # | Règle | Quoi | Pourquoi |
|---|---|---|---|
| A1 | **Auto-merge Renovate étendu** | Patch + minor + major + CVE auto-mergés si CI verte + smoke fonctionnel 24h vert sur staging. Plus aucune review humaine. | Dépendances toujours à jour, zéro PR qui traîne |
| A2 | **Auto-fix avant blocage** | Avant fail, la CI lance `eslint --fix`, `prettier --write`, `pnpm dedupe`. Commit `chore: autofix [skip ci]` poussé auto. | La CI corrige ce qu'elle peut, ne bloque que sur l'irréductible |
| A3 | **CVE → PR → merge auto** | Trivy runtime détecte CVE → issue auto + branche `fix/cve-<id>` avec bump deps auto + CI + merge auto si vert. | Chaîne sécurité sans intervention |
| A4 | **Self-healing crashes** | `veridian-docker-monitor` détecte container Exited → 3 restarts backoff exponentiel (10s → 1min → 5min) avant alerte Telegram. | 90 % des crashs transitoires se résolvent seuls |
| A5 | **Stale branch cleanup** | Branche feature inactive > 30 j sans PR → suppression auto. Branche merged → suppression auto (GitHub Settings). | Repo propre sans toi |
| A6 | **Pas de review humaine sur main** | 8 status checks verts = auto-merge. Pas de "PR review required". | La CI tranche, pas un humain |
| A7 | **Smoke fonctionnel chronométré** | Smoke = scénario E2E complet (signup → login → action métier → cleanup), pas juste `GET /`. Temps comparé au précédent run. Si > 2× précédent → rollback. | Détecte les régressions perf sans avoir besoin de trafic réel |
| A8 | **Synthetic monitoring 5 min** | Cron toutes les 5 min sur prod : même scénario que smoke. Génère ta propre baseline. 3 runs consécutifs dégradés → alerte. | Tu mesures sur ton propre trafic synthétique tant que pas d'users |

### 11.2 Couches activables quand trafic ≥ 100 req/min

À documenter mais **désactivées tant que pas de trafic réel** (sinon faux positifs garantis, baseline = 0).

| # | Règle | Activation |
|---|---|---|
| B1 | **Canary 20 % via Traefik weighted routing** | 10 min sur 20 % du trafic, promotion auto si métriques OK |
| B2 | **Auto-rollback sur métriques live** | Error rate > 2× baseline OU p95 > 2× baseline OU RAM > 90 % pendant 5 min |
| B3 | **Rollback budget** | > 3 rollbacks auto en 1h sur une app → freeze deploys 6h |

Quand prod atteint le seuil : `# uncomment` dans `_app-ci.yml` et c'est actif. Pas de redesign.

---

## 14. Constitution CI — racine uniquement

Définie une seule fois dans `veridian-platform/CLAUDE.md`. Les CLAUDE.md des apps en héritent.

```markdown
## Constitution CI

Standard officiel : `CI-ARCHITECTURE.md` (même dossier).

Règles non négociables :

1. **1 fichier critique = 1 test colocalisé au même chemin.** Scopes : `app/api/**/route.ts`,
   `components/**/*.tsx`, `hooks/**/*.ts(x)`, `lib/**/*.ts` (Next.js), `internal/handlers/*.go` (Go).
   Mapping par convention de chemin, zéro annotation, zéro exception.
2. **Pre-push hook bloquant.** Fichier critique modifié sans test colocalisé modifié → push refusé.
   Setup : `npm run setup-hooks` (ou `make setup-hooks` pour Notifuse).
3. **JAMAIS `--no-verify`.** Ni commit, ni push. Si hook bloque, fix le test.
4. **Path-based skip docs** : docs-only ne déclenchent pas la CI.
5. **Changements structurels** (Dockerfile, schema.prisma, compose, package.json/go.mod)
   doivent passer staging 24 h avant prod. Promotion auto si smoke + synthetic verts.
6. **Deploy via webhook Dokploy API** scopé Bearer (`/api/compose.deploy` ouvert public).
   Le reste de Dokploy reste Tailscale-only. Token rotaté tous les 6 mois.
7. **Renovate auto-merge total** : patch + minor + major + CVE auto-mergés si CI verte
   + smoke 24 h vert sur staging. Plus aucune review humaine.
8. **Trivy 9 capacités** : vuln + misconfig + secret + license (étage 1),
   image + EOL + SBOM (étage 2), cron hebdo (prod running).
   CRITICAL+HIGH bloquants en CI. CVE détectée → PR auto → merge auto si CI verte.
9. **Annotations Grafana** : chaque deploy + migration + rollback push une annotation
   via `obs annotate`. Source de vérité unique pour la timeline applicative.
10. **Pas de review humaine.** 8 status checks verts = auto-merge sur main.
    La CI tranche, pas Robert.
11. **Auto-rollback sur smoke fonctionnel chronométré.** Si scénario E2E post-deploy
    > 2× temps précédent → rollback auto. Synthetic monitoring 5 min génère la baseline
    tant que trafic réel insuffisant.
12. **Findings centralisés GitHub Security tab.** Tous les SARIF (Trivy + gitleaks) uploadés
    via `upload-sarif@v3`. Pas de `.trivyignore` sans VEX écrit (justification + reviewer + date).
13. **Migrations DB Expand & Contract obligatoire.** Le tag Docker `previous` doit toujours
    pouvoir tourner sur le schéma DB actuel. DROP COLUMN / RENAME / NOT NULL sur table peuplée
    bloqués par CI. Test backward-compat auto étage 2.
14. **MSW pour tout mock réseau.** Interdiction `vi.mock('fetch'|'axios'|'@/lib/api/*')`.
    Handlers déclarés dans `__tests__/mocks/handlers.ts`.
15. **Bundle size budget.** `size-limit` étage 1, CI rouge si First Load JS > +15 % baseline.
    Empêche Renovate de fat-bunder l'app sans alerte.
16. **Playwright `retries: 2` en CI.** Aucun rollback prod déclenché par un test flaky.
    Flaky detection auto > 5 % flake_rate sur 7 j → quarantaine + issue + PR `test.fixme()`.
17. **Coverage map au lieu de tests vides.** `test-coverage-map.yaml` versionné déclare
    les couvertures non-canoniques (ex : `lib/billing.ts` couvert par test integration paiement).
    Pas de `[skip-test-mapping]` en commit message.
18. **Rollback = Revert Git automatique.** Tout auto-rollback Docker déclenche un workflow
    `emergency-revert.yml` qui crée une PR de revert auto-mergée + freeze `main` jusqu'à
    résolution. Aucun commit fautif ne reste sur `main`.
19. **Supply chain blindée.** `pnpm install --frozen-lockfile --ignore-scripts` partout
    (CI + Dockerfile). Seuls les scripts whitelistés dans `pnpm.onlyBuiltDependencies`
    s'exécutent (husky, playwright, prisma). Tout autre `postinstall` est bloqué.
20. **Cleanup runner self-hosted obligatoire.** Step `always()` final qui prune containers,
    images, volumes orphelins, cache BuildKit > 7 j, dossiers /tmp. Lint workflow rejette
    tout job self-hosted sans ce step.
21. **Rétrocompatibilité sémantique = même rigueur que schéma.** Changement de format
    de donnée (E.164, ISO 8601, ULID, etc.) sur colonne existante = traité comme migration
    Expand & Contract (nouvelle colonne `<field>_v2`, dual-write, backfill, switch read, drop).
22. **Observabilité → CI (boucle fermée).** Alertes Grafana Cloud (OOM, memory creep,
    error rate spike, latence p95 doublée, synthetic 3× fail) câblées sur
    `repository_dispatch` GitHub qui déclenche `emergency-rollback.yml`. Plus de "personne
    n'écoutait l'alerte" — la CI agit elle-même.
23. **Branche close = stack rasée.** Chaque feature branch spawn une stack staging
    éphémère (URL `<app>-<branch-slug>.dev.veridian.site`). Au merge/close PR, workflow
    teardown `always()` : `docker compose down -v` + suppression dossier + prune images.
    GC hebdo pour rattraper les orphelins. **Zéro accumulation de cruft sur dev.**
24. **Compose pur sur dev, pas Dokploy.** Sur le dev server, Docker Compose + Traefik
    standalone. La CI contrôle 100 % le lifecycle (spawn, smoke, teardown, GC). Dokploy
    reste prod-only pour le SaaS qui tourne.
```

---

## 15. Checklist d'application (par app)

- [ ] `scripts/ci/check-test-mapping.sh` versionné (couvre routes + components + hooks + lib)
- [ ] `.husky/pre-push` installé + `npm run setup-hooks` documenté
- [ ] `tests-pending.txt` baseline générée auto (`find` sur tous les scopes critiques)
- [ ] `happy-dom` + `@testing-library/react` + `@testing-library/user-event` installés
- [ ] `vitest.config.ts` configure `environment: 'happy-dom'` pour les tests `__tests__/components/`
- [ ] `.github/workflows/ci.yml` appelle `_app-ci.yml` partagé
- [ ] `.github/renovate.json` aligné sur standard (auto-merge total)
- [ ] Branch protection `main` : 8 checks + no force-push (**pas de PR review required**)
- [ ] GitHub Environments `staging` et `production` créés
- [ ] Clé SSH déployée sur runner self-hosted (restriction `command=` dans authorized_keys)
- [ ] Compose file versionné dans le repo (source de vérité unique)
- [ ] Smoke fonctionnel chronométré documenté dans `runbooks/` (scénario E2E complet)
- [ ] Synthetic monitoring 5 min activé (cron sur dev server qui rejoue le smoke)
- [ ] `obs annotate deploy` câblé dans l'étage 3 (deploy + rollback)
- [ ] Auto-fix lint/prettier activé en étage 1 (commit `chore: autofix [skip ci]`)
- [ ] Self-healing 3 restarts configuré dans `veridian-docker-monitor`
- [ ] Trivy multi-scan (vuln + misconfig + secret + license) câblé étage 1
- [ ] Trivy image + EOL check + SBOM CycloneDX câblés étage 2 (SBOM = artifact)
- [ ] SARIF upload vers GitHub Security tab (étape `upload-sarif@v3` après chaque scan)
- [ ] `.trivyignore.yaml` créé (vide ou avec VEX statements) — pas de `.trivyignore` plat
- [ ] Repo GHCR `trivy-db` partagé pour cache DB Trivy (créé une fois pour toute l'org)
- [ ] `scripts/ci/check-migration-safety.sh` câblé étage 1 (bloque DROP/RENAME/NOT NULL)
- [ ] Job `test-backward-compat` étage 2 (image `previous` contre schéma N)
- [ ] `msw` installé + `__tests__/mocks/handlers.ts` + `__tests__/mocks/server.ts` setup
- [ ] `size-limit` configuré dans `package.json` avec budgets par chunk (.next/static/chunks/*)
- [ ] `playwright.config.ts` aligné sur standard (`retries: 2`, trace/video on failure)
- [ ] Workflow scheduled hebdo `playwright-flaky-detector.yml` créé
- [ ] `test-coverage-map.yaml` créé à la racine (vide initialement, peuplé au fil des PRs)
- [ ] `pnpm install --ignore-scripts` câblé étage 1 + Dockerfile
- [ ] `pnpm.onlyBuiltDependencies` whitelist dans `package.json`
- [ ] Workflow `emergency-revert.yml` créé (déclenché par `repository_dispatch`)
- [ ] Workflow `emergency-rollback.yml` créé (déclenché par alertes Grafana)
- [ ] PAT `GH_AUTOREVERT_PAT` créé + ajouté en secrets repo (scope: repo, workflow)
- [ ] PAT `GH_ROLLBACK_PAT` créé + ajouté côté Grafana Cloud webhook
- [ ] Step `always()` cleanup runner ajouté dans tous les jobs self-hosted
- [ ] Lint workflow YAML (custom) rejette jobs self-hosted sans cleanup step
- [ ] Alertes Grafana câblées : `oom_killed`, `memory_creep`, `synthetic_failed_3x` (jour 1)
- [ ] Alertes dormantes documentées : `error_rate_spike`, `latency_p95_doubled` (active si trafic ≥ 100 req/min)
- [ ] `DOKPLOY_API_KEY` ajouté en GitHub Secrets de chaque repo
- [ ] composeId Dokploy de l'app documenté dans son CLAUDE.md
- [ ] `docker-compose.dev.template.yml` créé avec variables `${APP}`, `${BRANCH_SLUG}`
- [ ] Workflow `staging-ephemeral.yml` créé (spawn + smoke + teardown `always()`)
- [ ] URL pattern documenté : `<app>-<branch-slug>.dev.veridian.site`
- [ ] Snapshot prod anonymisé restauré en staging à chaque deploy `main`

---

## 16. KPIs

| Métrique | Cible | Source |
|---|---|---|
| Fichiers critiques sans test (`tests-pending.txt`) | 0 sous 90 j | Cron hebdo → issue GitHub |
| Coverage component DOM | > 70 % par app | Vitest `--coverage` étage 1 |
| Coverage unit pures | > 85 % par app | Vitest `--coverage` étage 1 |
| Coverage integration API | > 60 % par app | Vitest `--coverage` étage 2 |
| Durée pipeline complet | < 4 min p95 | GitHub Actions usage |
| Taux d'échec staging deploy | < 5 % | GitHub Environments |
| Taux d'échec prod deploy (rollback) | < 1 % | GitHub Environments + smoke |
| CVE high+critical en prod | 0 | Trivy cron hebdo |
| PRs Renovate auto-mergées sous 7 j | > 95 % (auto-merge total) | Renovate dashboard |
| Secrets fuités (gitleaks + Trivy secret) | 0 | SARIF GitHub Security tab |
| Findings Security tab non triés > 7 j | 0 | GitHub Security tab |
| Licences GPL/AGPL en deps | 0 | Trivy license scan étage 1 |
| Images sur distro EOL | 0 | Trivy `--exit-on-eol` étage 2 |
| SBOM générés / push image | 100 % | Artifact GitHub Actions |
| Interventions humaines / semaine | 0 (objectif autonomie totale) | Compte des merges manuels + approvals |
| Auto-rollbacks déclenchés / mois | < 2 par app | GitHub Environments + annotations |
| Self-healings réussis (avant alerte) | > 80 % | `veridian-docker-monitor` logs |
| Synthetic monitoring uptime | > 99 % par app | Grafana Cloud dashboard |
| Migrations non-rétrocompatibles bloquées | 100 % (toutes les destructives) | Script `check-migration-safety.sh` |
| Tests Playwright en quarantaine | < 10 % du total | Job `playwright-flaky-detector` hebdo |
| Bundle First Load JS (hub) | Baseline + 15 % max | `size-limit` étage 1 |
| Bundle First Load JS (prospection) | Baseline + 15 % max | `size-limit` étage 1 |
| Coverage map entries justifiées | 100 % (`reason` non vide) | Schema check étage 1 |
| Rollback Docker sans revert Git | 0 (toujours couplés) | Workflow `emergency-revert.yml` |
| Scripts postinstall non whitelistés exécutés | 0 | `--ignore-scripts` strict + audit |
| Cleanup runner post-job réussi | 100 % | `always()` step + Telegram si échec |
| Re-deploys du même SHA fautif | 0 | Freeze main jusqu'à revert mergé |
| Stacks staging orphelines sur dev | 0 (GC hebdo) | `staging-gc.sh` cron |
| Disk dev server après PR close | Retour baseline < 30 min | `df -h` Grafana |
| Cleanup teardown réussi / PR closes | 100 % | Job `teardown` GitHub Actions |

---

## 17. Defense in Depth — colmater les angles morts

L'autonomie totale ouvre des classes d'incidents subtiles. Cette section colmate les 5 angles morts résiduels.

### 17.1 Rollback = Revert Git (anti boucle de redéploiement)

**Le scénario catastrophe** :
1. Renovate auto-merge une PR sur `main`, CI verte
2. Deploy prod → smoke passe mais bug latent
3. Auto-rollback Docker → image `previous` tourne, prod sauvée
4. **Git `main` contient toujours le commit fautif**
5. Prochaine PR mergée sur `main` → re-deploy → re-crash → boucle infernale

**Solution** : tout auto-rollback Docker déclenche un **revert Git automatique**.

#### Workflow `emergency-revert.yml`

```yaml
name: Emergency Revert
on:
  repository_dispatch:
    types: [rollback_triggered]

jobs:
  revert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, token: ${{ secrets.GH_AUTOREVERT_PAT }} }

      - name: Freeze main (read-only)
        run: |
          gh api -X PUT repos/${{ github.repository }}/branches/main/protection \
            -f required_pull_request_reviews.required_approving_review_count=0 \
            -f restrictions.users[]="" -f restrictions.teams[]="" -f restrictions.apps[]=""
          # Note : appelle un script qui POST aux API GitHub pour bloquer push direct
          # tant que le revert n'est pas mergé

      - name: Auto revert
        env:
          FAULTY_SHA: ${{ github.event.client_payload.sha }}
        run: |
          git config user.email "ci-bot@veridian.site"
          git config user.name "Veridian CI Bot"
          git checkout -b auto-revert/${FAULTY_SHA::8}
          git revert --no-edit $FAULTY_SHA
          git push origin auto-revert/${FAULTY_SHA::8}

      - name: Create + auto-merge revert PR
        run: |
          gh pr create \
            --title "revert: auto-revert $FAULTY_SHA (rollback prod)" \
            --body "Auto-generated revert after production rollback. Smoke fail detected on $FAULTY_SHA. Will auto-merge when CI green." \
            --label "auto-revert,critical"
          gh pr merge --auto --squash

      - name: Annotate Grafana
        run: obs annotate revert --app ${{ github.event.client_payload.app }}
                                   --sha $FAULTY_SHA
                                   --reason "auto-rollback prod"

      - name: Notify Telegram
        run: ./scripts/notify-telegram.sh "🚨 Auto-revert déclenché sur $FAULTY_SHA"
```

#### Freeze main jusqu'à résolution

Tant que la PR de revert n'est pas mergée, **GitHub branch protection passe `main` en mode strict** : aucun merge possible sauf la PR de revert elle-même. Évite que des PRs légitimes empilent leurs commits sur un `main` contaminé.

Levé auto par le job `revert` step `unfreeze-main` quand la PR de revert est mergée + smoke prod redevenu vert.

### 17.2 Supply Chain — `--ignore-scripts` strict

**Le scénario** : Renovate auto-merge un bump compromise. Le package contient un script `postinstall` malveillant. À l'étage 1, `pnpm install` exécute le script avant Trivy, vole `GHCR_TOKEN` ou altère le code.

**Solution** : `--ignore-scripts` partout où on installe.

#### Étage 1 (Quick checks)

```bash
# Au lieu de:
pnpm install --frozen-lockfile

# Toujours:
pnpm install --frozen-lockfile --ignore-scripts
```

#### Dockerfile builder

```dockerfile
# ❌ Interdit
RUN pnpm install --frozen-lockfile

# ✅ Imposé
RUN pnpm install --frozen-lockfile --ignore-scripts
```

#### Scripts whitelistés (cas exceptionnels)

Certains packages légitimes ont besoin de `postinstall` (Husky, Playwright pour télécharger les navigateurs, Prisma pour générer le client). Whitelist dans `pnpm.onlyBuiltDependencies` (pnpm 9+) :

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["husky", "@playwright/test", "prisma", "@prisma/client"]
  }
}
```

Tout autre script `postinstall` est **bloqué silencieusement**. Audit annuel de la liste.

### 17.3 Cleanup runners self-hosted

**Le scénario** : runner persistant traite PR A (malveillante ou flaky), laisse traîner un fichier dans `/tmp` ou empoisonne le cache BuildKit. PR B suivante utilise le cache corrompu → image empoisonnée déployée.

**Solution** : step `always()` final qui nettoie systématiquement.

```yaml
jobs:
  build-and-scan:
    runs-on: [self-hosted, dev, <app>]
    steps:
      - uses: actions/checkout@v4
      # ... étapes normales du job

      - name: Cleanup runner (always)
        if: always()
        run: |
          # Containers + images orphelins
          docker container prune -f
          docker image prune -f --filter "until=1h"
          # Volumes non-référencés (sauf ceux nommés explicitement)
          docker volume prune -f --filter "label!=keep=true"
          # Cache BuildKit > 7 jours
          docker buildx prune -f --keep-storage 10GB --filter "until=168h"
          # Workspace local
          sudo rm -rf /tmp/runner-${{ github.run_id }}-*
          # Vérif espace dispo
          df -h / | awk 'NR==2 {if ($5+0 > 80) exit 1}' || \
            ./scripts/notify-telegram.sh "⚠ Runner $(hostname) à $(df -h / | awk 'NR==2 {print $5}') de disk"
```

À terme, **Actions Runner Controller (ARC)** sur K8s pour des pods éphémères jetables après chaque job. Pas urgent tant qu'on est sur 1 dev server.

### 17.4 Rétrocompatibilité sémantique des données

**Le scénario** : schéma DB rétrocompatible (Expand & Contract OK), mais l'API N enregistre les téléphones en `+33600000000` (E.164) dans la colonne `phone` existante. L'API N-1 (rollback) attendait `0600000000`, crash en parsing les données insérées pendant les 2 min où N tournait.

**Solution** : **changement de format = changement de schéma**. Même rigueur, même pattern Expand & Contract.

Règles ajoutées au script `check-migration-safety.sh` :

```bash
# Détecte les changements de format implicites via code review
# Pas automatisable à 100%, mais alertable :

# Si un fichier `lib/format-*.ts` ou `lib/parse-*.ts` est modifié :
#   → exiger une nouvelle colonne `<field>_v2` dans une migration
#   → OU un feature flag `lib/feature-flags.ts` qui gate le nouveau format

# Si un fichier `prisma/schema.prisma` n'est pas modifié mais qu'un
# fichier `lib/validators/*.ts` change :
#   → annotation Grafana `semantic-change` pour traçabilité
#   → warning bloquant si le diff touche un format normalisé connu (E.164, ISO 8601, ULID...)
```

**Pattern de migration sémantique imposé** :

| Étape | Action |
|---|---|
| Expand | Ajouter colonne `phone_e164` (nullable) |
| Migrate code N+1 | Code écrit DANS LES DEUX colonnes, lit `phone_e164` avec fallback `phone` |
| Backfill | Job idempotent `parse + normalize phone → phone_e164` |
| Switch read | N+2 ne lit plus que `phone_e164`, écrit toujours les deux |
| Contract | N+3 drop `phone` ancienne colonne |

Identique à Expand & Contract schéma — pas d'exception pour "juste un changement de format".

### 17.5 Webhook Grafana → emergency-rollback

**Le scénario** : deploy passe smoke (30s) mais a une fuite mémoire. 3h plus tard, RAM 100%, OOM-kill. Personne ne réveille de rollback puisque la CI est terminée.

**Solution** : alertes Grafana cloud → webhook GitHub Actions → workflow rollback.

#### Webhook Grafana Cloud

Dans Grafana Cloud Alerting, contact point type **Webhook** pointe vers GitHub `repository_dispatch` :

```
URL: https://api.github.com/repos/Christ-Roy/veridian-infra/dispatches
Method: POST
Headers:
  Authorization: Bearer $GH_ROLLBACK_PAT
  Accept: application/vnd.github+json
Body:
  {
    "event_type": "rollback_triggered",
    "client_payload": {
      "app": "{{ .CommonLabels.app }}",
      "env": "prod",
      "reason": "{{ .CommonLabels.alertname }}",
      "sha": "{{ .CommonAnnotations.current_sha }}"
    }
  }
```

#### Alertes câblées sur le webhook

| Alerte | Condition | Action |
|---|---|---|
| `oom_killed` | Container restart count > 0 + exit code 137 | Rollback immédiat |
| `memory_creep` | RAM container > 90 % pendant 5 min | Rollback immédiat |
| `error_rate_spike` | Error rate > 2× baseline pendant 3 min | Rollback immédiat |
| `latency_p95_doubled` | p95 > 2× baseline pendant 5 min | Rollback immédiat |
| `synthetic_failed_3x` | Synthetic monitoring fail 3 runs consécutifs | Rollback immédiat |

**Toutes ces alertes déclenchent le même workflow** `emergency-rollback.yml` qui :
1. SSH prod-pub : `docker compose up -d <app>` avec tag `previous`
2. Trigger `emergency-revert.yml` (cf. §17.1) avec le SHA fautif
3. Annotation Grafana `incident-rollback`
4. Telegram + freeze main

**Ce qui boucle la boucle Observabilité → CI.** Plus de "personne n'écoutait l'alerte", c'est la CI elle-même qui agit.

### 17.6 Couches dormantes — quand activer

Ces protections sont **actives dès jour 1** sauf §17.5 partiellement :
- §17.5 alertes `error_rate_spike` + `latency_p95_doubled` exigent une baseline réelle (≥ 100 req/min)
- Tant que pas de trafic, on garde uniquement `oom_killed` + `memory_creep` + `synthetic_failed_3x`
- Activation des 2 autres alertes en même temps que §11.2 (canary, rollback métriques live)


---

## 18. Angles morts opérationnels — détectés en prod

> 🔥 Section ajoutée 2026-05-19 après audit terrain. Ces trous ne sont pas
> théoriques, ils ont **mordu en prod** au moins une fois. Chaque sous-section
> liste : (1) le scénario constaté, (2) la solution proposée, (3) le critère
> objectif "trou colmaté".

### 18.1 Smoke prod CI qui ment sur le SHA déployé

**Scénario constaté** : Push sur `main` → workflow CI/CD passe vert (build OK,
push GHCR OK, smoke prod `GET /api/health` 200 OK). Annonce officielle "deploy
success". **Mais le container prod tournait toujours sur l'image d'il y a 12h**
— Dokploy n'avait pas pull la nouvelle image, le webhook avait foiré
silencieusement.

Détection : par hasard, en testant un nouvel endpoint au curl qui n'existait
pas encore dans l'image active.

**Coût** : Divergence main↔prod silencieuse. Si l'incident n'est pas detecté à
la main, les commits suivants empilent les fonctionnalités absentes de prod.

#### Solution

Chaque app expose `GET /api/version` qui retourne :

```json
{
  "version": "0.2.0",
  "git_sha": "ad06e50",
  "build_time": "2026-05-19T12:13:14Z",
  "container_started_at": "2026-05-19T12:30:03Z"
}
```

- `git_sha` injecté au build via `ARG GIT_SHA` dans le `Dockerfile` puis
  exposé en env runtime : `ENV GIT_SHA=${GIT_SHA}` lu par la route.
- Le job CI `smoke-prod` ne se contente plus de `GET /api/health`. Il fait
  aussi `GET /api/version` et **vérifie** que `git_sha` retourné == SHA poussé.
  Si mismatch après 90s de retry → fail le smoke, déclenche `emergency-rollback`.

#### Pattern de smoke renforcé (étage 3 deploy)

```yaml
- name: Smoke prod (strict SHA check)
  env:
    EXPECTED_SHA: ${{ github.sha }}
  run: |
    for i in $(seq 1 6); do
      VERSION_JSON=$(curl -fsSL "https://${APP}.app.veridian.site/api/version" || echo '{}')
      ACTUAL_SHA=$(echo "$VERSION_JSON" | jq -r '.git_sha // empty')
      if [ "${ACTUAL_SHA:0:7}" = "${EXPECTED_SHA:0:7}" ]; then
        echo "✓ Prod is on $ACTUAL_SHA (expected $EXPECTED_SHA)"
        exit 0
      fi
      echo "⏳ Prod still on $ACTUAL_SHA (attempt $i/6), waiting 15s..."
      sleep 15
    done
    echo "::error::Prod did not reach expected SHA after 90s — Dokploy did not pull"
    exit 1
```

**Critère "trou colmaté"** : impossible qu'un workflow main passe vert sans que
le SHA prod corresponde exactement au commit pushé.

### 18.2 Dokploy webhook GitHub silently failing

**Scénario constaté** : 2026-05-19, le webhook GitHub→Dokploy n'a pas pull la
nouvelle image après 2 push consécutifs (P1 puis P2.1). Aucune erreur visible.
Il a fallu forcer `compose.deploy` via l'API Dokploy à la main.

**Causes possibles** (non identifiées précisément) :
- `pull_policy: missing` au lieu de `always` côté Dokploy
- Webhook délivré mais file de jobs Dokploy saturée
- Token GHCR expiré côté Dokploy

#### Solution

1. **Vérifier `pull_policy: always`** dans tous les `docker-compose.yml` Dokploy.
   Sans ça, Dokploy peut "redeploy" en restartant le container sans pull.
2. **Webhook redondant** : en plus du webhook GitHub→Dokploy, ajouter en
   fin de pipeline CI un step `compose.deploy` via API Dokploy en redondance.
   La 2e mise à jour est un no-op si la 1ère a marché.
3. **Health-check du webhook** : cron quotidien qui pousse un commit de test
   (genre `chore: webhook-canary [skip ci]`) sur un repo dummy + vérifie
   que Dokploy a reçu et exécuté. Telegram si KO.

```yaml
- name: Redeploy via Dokploy API (redundancy)
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  env:
    DOKPLOY_API_KEY: ${{ secrets.DOKPLOY_API_KEY }}
    COMPOSE_ID: ${{ vars.DOKPLOY_COMPOSE_ID }}
  run: |
    curl -sS -X POST "https://dokploy.veridian.site/api/compose.deploy" \
      -H "x-api-key: $DOKPLOY_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"composeId\":\"$COMPOSE_ID\"}"
```

**Critère "trou colmaté"** : §18.1 garantit déjà la détection ; §18.2 garantit
la double-redondance pull.

### 18.3 Crons silencieusement KO depuis N jours

**Scénario constaté** (2026-05-19, depuis supprimé) : Un cron quotidien
`prospection-e2e-cleanup` (legacy, nettoyait `auth.users` Supabase avant la
migration Auth.js) a tourné en erreur ~5 jours d'affilée sans alerte. Cause
identifiée a posteriori : hostname obsolète post-migration Traefik. Le cron
lui-même a été supprimé (cleanup Supabase global — contrat Hub §5.7-5.8 +
endpoint `POST /api/tenants/soft-delete` remplace toute la chaîne).

Mais l'angle mort reste valable pour **tous les futurs crons** : un cron
qui échoue ne crie pas. Personne ne lit les emails GitHub Actions.

**Coût** : N'importe quel cron critique (reconciliation Stripe, health-check
Hub→app, mutation testing nightly) peut tourner KO pendant des semaines.

#### Solution

1. **Tout cron scheduled DOIT avoir** une notification Telegram `on: failure`.
   Pas un mail GitHub (lu par personne), pas un Slack lointain. Telegram
   ouvert sur le téléphone.

```yaml
- name: Notify Telegram on failure
  if: failure()
  run: |
    curl -sS "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d chat_id=${TG_CHAT_ID} \
      -d "text=🚨 Cron <b>${{ github.workflow }}</b> failed: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

2. **Cron meta-watchdog** : un job hebdo (dimanche) liste tous les crons
   actifs du repo, vérifie le dernier `conclusion` via GH API, alerte si
   `failure` x≥2 consécutifs.

```bash
gh api repos/${REPO}/actions/runs --jq '
  group_by(.name) |
  map({
    name: .[0].name,
    last_3: [.[0:3] | .[].conclusion]
  }) |
  map(select(.last_3 | length == 3 and all(. == "failure")))
'
```

**Critère "trou colmaté"** : impossible qu'un cron échoue 2 fois consécutives
sans alerte Telegram.

### 18.4 Logs apps inaccessibles hors SSH + perdus au restart

**Scénario constaté** : Quand un container restart (rolling deploy), les logs
précédents sont écrasés selon la config Docker (rotation defaults
`max-size=10m, max-file=3`). Si demain un user dit "j'ai eu une erreur ce
matin", on fouille à la main sans contexte.

#### Solution — Glitchtip self-hosted (1 container Dokploy)

Glitchtip = fork OSS de Sentry. **Compatible SDK Sentry**, 1 container vs
5 pour Sentry self-hosted.

| Composant | Effort | Bénéfice |
|---|---|---|
| Glitchtip container Dokploy (postgres + web + worker en 1 compose) | 1h infra | Stack OK |
| SDK `@sentry/nextjs` sur 5 apps Next.js | 30 min × 5 = 2.5h | Capture exception serveur + breadcrumbs auth/Stripe |
| SDK `sentry.io/go` sur Notifuse | 30 min | Idem Go |
| Retention 30j configurée | 5 min | Suffit pour debug post-incident |

Avantage par rapport à Loki/ELK : on capture **les erreurs avec contexte**
(user, tenant, request_id) sans avoir à se taper la centralisation totale
des logs (1000× plus lourd).

**Critère "trou colmaté"** : 100% des erreurs 5xx prod arrivent dans Glitchtip
dans les 30s avec stacktrace + user_id + tenant_id + request_id.

### 18.5 Désalignement Stripe ↔ DB (revenue leak)

**Scénario à venir (pas encore mordu, mais inévitable)** : Stripe envoie
`subscription.deleted` et le webhook Hub plante (5xx, rate-limit, bug code).
Stripe retry mais finit par abandonner. Le tenant garde son plan pro
alors qu'il a annulé. **Aucune réconciliation cron côté Hub**.

#### Solution — Cron reconciliation Hub→Stripe (1 fois/24h)

Côté Hub, cron quotidien qui :

1. Liste tous les tenants avec `planSource = "stripe"` actifs en DB
2. Pour chaque tenant : `stripe.subscriptions.retrieve(stripe_subscription_id)`
3. Compare `tenants.plan` DB vs mapping de `stripe_price_id` actuel
4. Si divergence → log + Telegram + écrit dans `tenants.metadata.reconciliation_pending=true`
5. Action humaine requise (Robert review + click "Force sync") pour résoudre

**Pas de fix automatique** car un downgrade Stripe→free peut être un faux
positif (carte expirée → past_due puis recovery) — l'humain décide.

**Critère "trou colmaté"** : alerte Telegram dans les 24h max pour toute
divergence Stripe ↔ DB plan.

### 18.6 Health-check Hub→app pas câblé (contrat §5.5 non implémenté)

**Scénario constaté** : Le contrat §5.5 exige `GET /api/tenants/{id}/health`
côté chaque app downstream, appelée en cron 1×/h par le Hub. Le endpoint
existe côté Prospection (livré P2.1), mais **le cron Hub appelant n'existe pas**.

Conséquence : si l'api_key Prospection est révoquée silencieusement, le Hub
ne le sait que quand un user clique "Open Prospection" et reçoit 401. UX
dégradée + temps de détection > 1h sur 24h.

#### Solution — Cron Hub `/health` 1×/h par app provisionnée

Côté Hub, workflow scheduled `health-poll.yml` ou job systemd sur prod qui :

1. Liste tous les tenants avec `prospectionProvisionedAt != null`
2. Pour chaque, `GET /api/tenants/{tenant_id}/health` signé HMAC
3. Si `status != "active"` OU `magic_link_capable=false` OU `members_count=0`
   → écrit dans `hub_app.tenant_health_check (tenant_id, app, last_status, last_checked_at)`
4. Si **changement** de status depuis dernière check → Telegram alerte

**Critère "trou colmaté"** : impossible qu'un tenant en état dégradé reste
indétecté > 1h.

### 18.7 Husky NUCLEAR : couverture sans qualité (mutation testing)

**Scénario constaté** : Le hook pre-push vérifie qu'un fichier de test existe
**par nom** (`__tests__/api/<path>.test.ts`). Il ne vérifie **pas que le test
exerce vraiment le code**. Audit du 2026-05-19 a révélé 11 tests bâclés qui
passaient toutes les CI alors que sabotage des invariants ne les faisait pas
échouer (notamment l'émission webhook `tenant.resumed` non assertée).

#### Solution couche 1 — Message anti-bâclage dans la pop-up Husky (livré)

Dans les 5 repos (`Hub`, `Prospection`, `Analytics`, `CMS`, `Notifuse`), la
pop-up `PUSH REFUSÉ` affiche désormais :

```
message de robert: NE BACLE PAS LES TESTS, il faut les tester
et s'assurer qu'ils soient pertinent et ne casse pas la ci pour
rien et qu'ils durent !
```

Effet psychologique. Pas suffisant seul.

#### Solution couche 2 — Mutation testing nightly (Stryker)

Outil : `stryker-mutator` pour TS, `gremlins.js` pour Go.

Workflow scheduled hebdo (dimanche 02:00 UTC, low-traffic) :

1. Lance Stryker sur `src/lib/hub/`, `src/lib/queries/`, `src/lib/auth/`
   (libs critiques contractuelles)
2. Calcule le **mutation score** : `mutations tuées / total mutations`
3. Si score < 80% sur un fichier critique → issue GitHub auto + Telegram
4. Dashboard HTML hébergé en GitHub Pages publique

**Pourquoi pas par push** : Stryker coûte 5-10 min même sur un petit
codebase. Trop lourd pour le pipeline ship-fast. Mais **nightly suffit** car
les régressions de qualité mettent des semaines à apparaître, pas des heures.

**Critère "trou colmaté"** : aucun fichier critique sous 80% mutation score
plus de 7 jours.

### 18.8 Time-to-live opaque (durée push→live)

**Scénario constaté** : Pas de métrique sur le temps entre `git push main` et
"le code tourne vraiment en prod". Aujourd'hui c'est entre 5 min (heureux) et
**jamais** (Dokploy ne pull pas — §18.1).

#### Solution

Logger au startup de chaque app, dans les 10s post-démarrage :

```ts
console.log(JSON.stringify({
  event: "app.live",
  git_sha: process.env.GIT_SHA,
  build_time: process.env.BUILD_TIME,
  started_at: new Date().toISOString(),
  ttl_seconds_since_build: Math.floor((Date.now() - Date.parse(process.env.BUILD_TIME)) / 1000),
}));
```

Collecté par Grafana Cloud Alloy (déjà installé sur prod). Dashboard
"time-to-live par app" affiche le p50/p95 sur 7j glissants.

**Critère "trou colmaté"** : p95 push→live < 10min sur 7j glissants pour
toutes les apps.

---

## 19. Politique de promotion différenciée par app

> 🔥 Section ajoutée 2026-05-19. Le mode "trunk-based + auto-promote" décrit
> dans le CLAUDE.md racine de veridian-platform n'est **pas universel**.
> Il dépend de la **tolérance à la casse prod** de chaque app.

### 19.1 Matrice par app

> ⚠️ **Cette matrice est PARTIELLEMENT obsolète depuis 2026-05-20**.
> Hub, CMS et Notifuse étaient en auto-promote inconditionnel mais le mode
> "auto-promote si staging vert" s'avère insuffisant pour les apps qui touchent
> à des chemins critiques (auth, billing, migration DB).
>
> **Voir §20 "Promotion graduée par risque"** pour le modèle actuel qui remplace
> la colonne "Promotion staging→main" de cette matrice. §19.1 ne garde qu'une
> valeur descriptive ("Tolérance casse prod"), pas opérationnelle.

| App | Criticité | Tolérance casse prod |
|---|---|---|
| **Prospection** | 🔴 Critique | Très faible — c'est l'app de revenu actif |
| Hub | 🔴 Critique | Faible — bloque flow signup, billing, et propagation session vers toutes les apps |
| Analytics | 🟡 Important | Moyenne — analytics manquantes = pas de revenue lost mais data gap |
| CMS | 🟡 Important | Moyenne — sites clients en lecture seule pendant downtime |
| Notifuse | 🟡 Important | Moyenne — emails transactionnels peuvent attendre 30min |

### 19.2 Mode Prospection : "staging-only ship + giga MAJ"

**Règle** : sur Prospection, **JAMAIS d'auto-promote staging→main**. Toute
modif est shipée à volonté sur `staging`. La promotion vers `main` (prod) se
fait par **giga-MAJ humaine** après validation explicite Robert.

#### Garde-fou anti-promotion accidentelle

Le `CLAUDE.md` racine du repo Prospection (`veridian-prospection/CLAUDE.md`)
contient une instruction explicite :

```markdown
## 🚨 Promotion prod = STRICTEMENT HUMAINE

Prospection est l'app critique Veridian. Aucun agent ne doit jamais faire :
- `git merge --no-ff origin/staging` sur main
- `git push origin main` après staging vert
- `gh workflow run prospection-ci.yml --ref main`

Tout push doit aller exclusivement sur `staging`. La promotion main sera
faite par Robert en mode giga-MAJ explicite (commande "promote prod"
attendue). Si tu as un doute, c'est NON.
```

#### Workflow `prospection-ci.yml` reste sur `main` mais n'est plus déclenché par push agent

Le workflow garde son trigger `on: push: branches: [main]` (utile pour les
giga-MAJ humaines), mais aucun agent ne le déclenche. Le job `deploy-prod`
n'a pas d'auto-promote du tout — il ne s'exécute que sur push main réel.

### 19.3 Mode auto-promote (Hub / Analytics / CMS / Notifuse)

Pattern de référence : `cms-staging.yml` job `promote-to-main`. Pour câbler
sur Hub et Analytics (manquent encore), copier ce pattern :

```yaml
promote-to-main:
  name: Auto-promote staging → main
  needs: [deploy, smoke-staging]   # exige staging vert ET smoke vert
  if: github.event_name == 'push' && github.ref == 'refs/heads/staging' && !contains(github.event.head_commit.message, '[skip-prod]')
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: 0
        token: ${{ secrets.GH_AUTOPROMOTE_PAT }}  # PAT scope: repo
    - name: Fast-forward merge staging → main
      run: |
        git config user.email "ci-bot@veridian.site"
        git config user.name "Veridian CI Bot"
        git fetch origin main
        git checkout main
        git merge --ff-only origin/staging || {
          echo "::error::main a divergé de staging — promotion impossible en ff-only"
          exit 1
        }
        git push origin main
    - name: Trigger CI prod
      run: gh workflow run ci.yml --ref main
      env: { GH_TOKEN: ${{ secrets.GH_AUTOPROMOTE_PAT }} }
    - name: Notify Telegram
      if: always()
      run: |
        ICON=$([ "${{ job.status }}" = "success" ] && echo "✅" || echo "🚨")
        curl -sS "https://api.telegram.org/bot${{ secrets.TG_BOT_TOKEN }}/sendMessage" \
          -d chat_id=${{ secrets.TG_CHAT_ID }} \
          -d "text=$ICON ${{ github.repository }} auto-promote staging→main ${{ job.status }}"
```

### 19.4 Conditions d'éligibilité auto-promote (3 garde-fous)

Pour qu'un app passe en mode auto-promote, **les 3 conditions suivantes
doivent être vérifiées** :

1. **Smoke staging réussit à 100%** (healthcheck + endpoints critiques + e2e Playwright `--project=chromium`)
2. **Migration safety check passe** (cf. §4 Expand & Contract — pas de DROP/RENAME/NOT NULL non gated)
3. **`/api/version` retourne le bon SHA** post-deploy staging (cf. §18.1)

Si une seule condition échoue, promotion bloquée. Investigation manuelle.

### 19.5 Trigger giga-MAJ Prospection (procédure humaine)

Quand Robert valide la giga-MAJ Prospection :

```bash
# 1. Robert ouvre une session sur l'agent Prospection
# 2. "promote prod maintenant"
# L'agent fait :

git fetch origin
git checkout main
git pull --ff-only
# Si pas ff-only possible : "main a divergé de staging, je veux ton accord pour merge --no-ff" + STOP
git merge --no-ff origin/staging -m "chore: giga-promote staging → main (validated by Robert YYYY-MM-DD)"
git push origin main

# 3. L'agent watch le run CI prod jusqu'à vert
# 4. L'agent smoke prod via curl HMAC + Chrome MCP login pattern
# 5. Si rouge : agent investigue, ne re-promote pas sans accord
```

### 19.6 Audit de conformité par app

Le job CI étage 1 ajoute un check :

```bash
# scripts/ci/check-promotion-policy.sh
APP=$(basename $(git rev-parse --show-toplevel))
if [ "$APP" = "veridian-prospection" ]; then
  if grep -q "promote-to-main" .github/workflows/*.yml; then
    echo "::error::Prospection ne doit PAS avoir d'auto-promote (cf. CI-ARCHITECTURE §19.2)"
    exit 1
  fi
else
  if ! grep -rq "promote-to-main" .github/workflows/*.yml; then
    echo "::warning::$APP devrait avoir un job promote-to-main (cf. §19.3)"
  fi
fi
```

**Critère "trou colmaté"** : aucun PR ne peut introduire de l'auto-promote
sur Prospection ; les autres apps doivent en avoir un (warning).

---

## 20. Promotion graduée par risque — protocole agent

> 🔥 **Section décidée 2026-05-20 par Robert.** Le mode "auto-promote si staging
> vert" décrit en §19.3 n'offre pas assez de filtres pour les apps critiques.
> §20 introduit une **échelle de risque par commit** qui détermine le chemin de
> promotion. **L'agent arbitre seul et exécute** ; Robert est manager, pas valideur
> obligatoire. Objectif : zéro casse prod sans ralentir la vitesse de dev.

### 20.1 Principe — l'agent est responsable, pas demandeur

Chaque commit/série de commits sur `staging` est **classifié par l'agent** selon
le risque qu'il représente pour la prod. Le chemin de promotion `staging → main`
dépend de cette classification.

**Inversion 2026-05-20** : l'agent ne demande plus la permission `go/stop`
sur chaque promo. C'est un **subordonné senior de confiance**, pas un junior
qui valide chaque action. Le cadre §20 lui donne :
- une **grille de classification objective** (§20.3),
- des **protocoles de validation par tier** (§20.4-20.7),
- des **garde-fous techniques** (pre-push, CI gates, marker `[risk:low]`),
- une **piste d'audit** (la reco écrite est la trace, pas la demande).

L'agent **exécute la promo** dès que :
1. Le tier est correctement classifié (validation auto par garde-fous).
2. Le protocole de validation du tier est exécuté et vert.
3. La reco écrite est produite (et envoyée à Robert pour audit/info).

L'agent **demande explicitement** seulement pour le **tier 💀 CRITIQUE**
(cf. §20.7). Pour les autres tiers, Robert intervient **uniquement par veto
explicite** : "stop", "rollback", "attends", "annule". L'agent doit alors :
- Si la promo n'est pas encore faite → annuler le merge.
- Si la promo est faite → exécuter le rollback documenté dans la reco.

### 20.1.1 Veto manager — comment Robert reprend la main

Robert peut intervenir à tout moment :

| Mot-clé Robert | Effet attendu agent |
|---|---|
| `stop` / `attends` | Annuler la promo en cours OU bloquer la prochaine sur ce push staging |
| `rollback` | `git revert` du commit promu + push main + monitoring jusqu'à recovery |
| `freeze` | Geler tous les push staging → main sur cette app jusqu'à `unfreeze` |
| `unfreeze` | Reprendre le flow normal |

Robert n'a pas besoin de justifier. L'agent obtempère sans débat, met à jour
les memories pertinentes ("project: freeze Hub décidé YYYY-MM-DD parce que
[...]"), et reste en standby.

### 20.2 Échelle de risque (4 niveaux)

| Tier | Exemples typiques | Action agent |
|---|---|---|
| 🟢 **BAS** | doc, todo/CHANGELOG, README, test ajouté sans modif code, refactor sans changement de surface API publique, rename de variable interne, fix typo, bump version cosmetic | **Auto-promote via marker `[risk:low]`** dans le subject. Agent rend compte en 1 ligne post-promo. |
| 🟡 **MOYEN** | nouvelle route API non-auth, modif UI dashboard sans impact billing, nouvelle ENV optionnelle avec fallback, ajout d'un provider OAuth (cf. commit aab5a68), fix bug non-critique, bump dépendance patch | **Agent promote après** smoke CI vert + reco écrite produite pour audit. Pas de validation Robert requise. |
| 🔴 **HAUT** | modif auth (callbacks, sessions, providers), modif billing/Stripe, migration DB (même Expand/Contract), modif lib partagée (lib/auth, lib/stripe, lib/prisma), refactor d'un endpoint Hub consommé par d'autres apps, modif compose.yml prod | **Agent promote après** smoke CI + E2E headfull staging vert + reco écrite + auto-monitoring 10 min post-deploy. Pas de validation Robert requise. |
| 💀 **CRITIQUE** | rotation secret prod, DROP COLUMN, suppression de tenant, refactor du système de session, modif du contrat HMAC Hub↔app, modif du flow Stripe webhook, modif du provisioning | **Agent DEMANDE explicitement** avant push staging ET avant promo prod. Seul tier où Robert valide en go/stop. 4 yeux obligatoire. |

**Veto Robert** applicable à tous les tiers via les mots-clés §20.1.1.

### 20.3 Comment l'agent classifie

L'agent évalue le tier en regardant **ce que les commits non-promus touchent** :

```bash
# Diff vs main (commits déjà sur staging pas encore en prod)
git diff --name-only origin/main...origin/staging
```

Puis applique cette grille :

| Fichier touché | Tier minimum |
|---|---|
| `**/*.md`, `todo/**`, `docs/**` | 🟢 BAS |
| `**/*.test.ts(x)`, `__tests__/**` (seul, sans source) | 🟢 BAS |
| `components/**` hors auth/billing/dashboard sensibles | 🟡 MOYEN |
| `app/api/**/route.ts` nouvelle route non-critique | 🟡 MOYEN |
| `compose/staging.yml` seul (pas prod.yml) | 🟡 MOYEN |
| `auth.ts`, `auth.config.ts`, `lib/auth/**`, `app/api/auth/**`, `middleware.ts` | 🔴 HAUT |
| `lib/stripe/**`, `app/api/billing/**`, `app/api/webhooks/stripe/**` | 🔴 HAUT |
| `prisma/migrations/**`, `prisma/schema.prisma` | 🔴 HAUT (ou 💀 CRITIQUE si DROP/RENAME) |
| `compose/prod.yml`, `Dockerfile`, `.github/workflows/*-ci.yml` | 🔴 HAUT |
| `lib/notifuse/**`, `lib/prospection/**`, `utils/tenants/provision.ts` | 🔴 HAUT |
| Rotation secret, scripts/admin/*-prod*, modif contrat HMAC | 💀 CRITIQUE |

**Règle d'escalade** : si un commit touche **plusieurs scopes**, l'agent retient
le tier **le plus élevé**. Pas de moyenne, pas de pondération — la prudence
gagne toujours.

### 20.4 Protocole tier 🟢 BAS — auto-promote conservé

L'auto-promote staging→main reste actif **uniquement** pour les commits
classifiés 🟢 BAS. Câblage CI :

```yaml
promote-to-main:
  if: |
    github.event_name == 'push' &&
    github.ref == 'refs/heads/staging' &&
    contains(github.event.head_commit.message, '[risk:low]')
```

L'agent **doit** ajouter le marker `[risk:low]` dans le message de commit pour
déclencher l'auto-promote. Absence du marker = pas de promotion auto, même si
le staging passe vert.

**Faute professionnelle** : taguer `[risk:low]` un commit qui touche
`lib/auth/**` ou `prisma/**`. Le pre-push hook a un check qui détecte les
incohérences (cf. §20.7).

### 20.5 Protocole tier 🟡 MOYEN — agent promote après reco écrite

**Séquence agent** (autonome, pas de go Robert) :

1. Push staging → attendre staging CI vert.
2. Produire la **reco écrite** dans le chat (audit / info Robert).
3. **Exécuter la promo** : `git checkout main && git merge --ff-only origin/staging && git push origin main`.
4. Watch run CI prod jusqu'à vert.
5. Smoke prod (curl /api/health + check chunks JS hash si pertinent).
6. **Si Robert poste un veto pendant les étapes 2-5** → arrêter la promo OU
   rollback selon où on en est (cf. §20.1.1).

Format de la reco écrite (audit log, pas demande de validation) :

```
🟡 PROMO STAGING → PROD — Hub commit <sha7>

Changement : <résumé 1 phrase>
Tier de risque : MOYEN
Justification : <pourquoi MOYEN et pas HAUT/BAS>

Surface touchée :
  - <fichier 1> (<raison brève>)
  - <fichier 2> (<raison brève>)

Validation effectuée :
  ✅ CI staging vert (run #<n> — <lien>)
  ✅ Tests unitaires : <X>/<X> passent
  ✅ Smoke headless staging : 200 sur /api/health, dashboard render
  ✅ Pas de migration DB
  ✅ Fail-safe vérifié : <comment ça dégrade si X tombe>

Risques résiduels :
  - <risque 1 + impact>
  - <risque 2 + mitigation>

Décision agent : PROMOTE PROD MAINTENANT (rollback prêt sur <SHA précédent>)
              ou  HOLD (raison : <...>)

→ Veto Robert via "stop" / "rollback" si tu vois passer ça.
```

**Si l'agent décide HOLD** (rare en tier 🟡) : le commit reste sur staging,
l'agent écrit une note dans `todo/` expliquant pourquoi, et continue à
travailler. Pas d'attente passive de Robert.

### 20.6 Protocole tier 🔴 HAUT — agent promote après E2E headfull + monitoring

Tier HAUT = l'agent **doit** lancer le script E2E headfull avant de promote :

```bash
pnpm e2e:staging:full
```

Ce script (cf. §20.8) parcourt en navigateur réel sur `hub.staging.veridian.site`
les 5-8 user journeys critiques (signup, login Google, login Microsoft si secret
configuré, dashboard, billing portal, settings, etc.).

**Séquence agent** (autonome, pas de go Robert) :

1. Push staging → attendre staging CI vert.
2. Lancer `pnpm e2e:staging:full` → exiger 100% des parcours verts.
3. Produire la **reco écrite** (cf. format 20.5, avec section "E2E headfull").
4. **Exécuter la promo** : ff-merge + push main + trigger hub-ci.yml.
5. Watch CI prod jusqu'à vert.
6. **Monitoring 10 min post-deploy** :
   - Smoke prod toutes les 1 min (`curl https://app.veridian.site/api/health`).
   - Tail logs Hub via Dokploy API (`docker.getContainerLogs`) — chercher errors.
   - Si Grafana alert / 5xx > 1% / health 500 → **auto-rollback** sans demander.
7. Si tout vert à T+10 min → fermer la reco avec "✅ prod stable, monitoring OK".

**Si E2E headfull échoue à au moins 1 parcours** : pas de promo, l'agent
investigue et fix sur staging d'abord. Reco écrite avec section "BLOQUÉ".

La reco ajoute par rapport au tier 🟡 :

```
🔴 PROMO STAGING → PROD — Hub commit <sha7>

[... même format que 20.5 ...]

Validation effectuée :
  ✅ CI staging vert
  ✅ Tests unitaires
  ✅ Smoke headless CI
  ✅ E2E headfull staging : 9/9 parcours OK (rapport : e2e-headfull-<sha7>.json)
  ✅ Monitoring post-deploy programmé : 10 min smoke + tail logs
  ✅ Plan rollback : git revert <sha> + push main (auto si trigger)

[... idem ...]

Décision agent : PROMOTE PROD MAINTENANT
                + monitoring auto 10 min
                + rollback auto si anomalie

→ Veto Robert via "stop" / "rollback" pendant la fenêtre.
```

### 20.7 Protocole tier 💀 CRITIQUE — 4 yeux + dry-run

**SEUL TIER** où l'agent demande explicitement go/stop. Justification :
ces actions sont **irréversibles** (DROP COLUMN, rotation secret en cours
de session active, suppression de tenant) et engagent le business.

L'agent ne pousse même pas le commit sur staging sans avoir préalablement :

1. Décrit la modif et le tier à Robert ("c'est un tier CRITIQUE parce que…").
2. Reçu un `ok pour staging` explicite.
3. Préparé un plan de rollback détaillé (commandes exactes, secret de bascule,
   trigger de revert, etc.).

Après staging vert et toute la batterie de tests :

- L'agent fournit la reco tier 🔴 + un **diff annoté ligne par ligne** des
  changements sur les chemins sensibles.
- L'agent propose un **dry-run** si possible (ex : test du flow de rotation
  secret sur un compte test, sans toucher au compte principal).
- Robert répond `go` ou `stop`.
- Sur `go` : promotion main + monitoring renforcé 30 min post-deploy.
- Sur `stop` : freeze automatique de l'app jusqu'à `unfreeze`.

### 20.8 Outil agent — script E2E headfull staging

Localisation : `veridian-hub/scripts/e2e/staging-full.sh` (ou équivalent par app).

```bash
#!/usr/bin/env bash
# Lance Playwright headfull sur hub.staging.veridian.site.
# Parcourt les user journeys critiques avec un vrai navigateur.
# Pas dans la CI (trop long+flaky pour bloquer). Outil agent opt-in.
#
# Usage : pnpm e2e:staging:full
#         pnpm e2e:staging:full --update-snapshots
#
set -euo pipefail

STAGING_URL="${STAGING_URL:-https://hub.staging.veridian.site}"

# Pré-check : staging répond
if ! curl -sf -o /dev/null "${STAGING_URL}/api/health"; then
  echo "::error::Staging KO — abort E2E headfull"
  exit 1
fi

# Lance Playwright avec config dédiée (headfull, slowMo, screenshots on-failure)
HEADED=1 pnpm exec playwright test \
  --config=playwright.staging-full.config.ts \
  --reporter=json --output=e2e-headfull-staging.json

# Genère le récap formaté pour la reco agent
node scripts/e2e/format-staging-report.js e2e-headfull-staging.json
```

**Coverage attendu par journey** :

1. **Signup credentials** : `/signup` → email/password → dashboard
2. **Login credentials** : `/login` → email/password → dashboard
3. **Login Google** (avec compte test) : `/login` → bouton Google → dashboard
4. **Login Microsoft** (si secret Entra dispo en staging) : `/login` → bouton MS → dashboard
5. **Dashboard render** : tous les widgets chargent < 2s sans erreur console
6. **Settings → Account** : afficher email + comptes connectés
7. **Billing portal** : redirect vers Stripe portal sans erreur
8. **Auto-login Notifuse** : depuis dashboard, cliquer "Open Notifuse" → page Notifuse login auto

**Durée cible** : 8-15 min. Si > 20 min, le script signale `::warning::` mais
ne fail pas.

### 20.9 Garde-fou pre-push — cohérence marker [risk:low]

`scripts/ci/check-risk-marker.sh` (à ajouter) :

```bash
#!/usr/bin/env bash
# Refuse un commit qui claim [risk:low] mais touche un chemin tier 🔴+.
set -euo pipefail

LAST_MSG=$(git log -1 --format=%B)
if echo "$LAST_MSG" | grep -q '\[risk:low\]'; then
  CHANGED=$(git diff --name-only HEAD~1)
  if echo "$CHANGED" | grep -qE '(auth\.(ts|config\.ts)|lib/auth/|lib/stripe/|prisma/migrations/|compose/prod\.yml|app/api/auth/|app/api/billing/|app/api/webhooks/stripe/)'; then
    echo "::error::Commit taggé [risk:low] mais touche un chemin tier 🔴+ (cf. CI-ARCHITECTURE §20.3)"
    exit 1
  fi
fi
```

Branché dans `.husky/pre-push` après `check-test-mapping.sh`.

### 20.10 Apps concernées par §20

| App | §20 applicable | Notes |
|---|---|---|
| **Hub** | ✅ Oui (depuis 2026-05-20) | Re-classifiée 🔴 Critique car SSO central + billing |
| **Prospection** | ✅ Oui — confluence avec §19.2 | Déjà en mode "staging-only ship + giga-MAJ", §20 ajoute juste la reco écrite obligatoire avant giga-MAJ |
| Analytics | 🔵 À activer quand client réel | Tant qu'on n'a pas de tenant Analytics en prod, le risque est nul |
| CMS | 🔵 À activer quand client réel | Idem |
| Notifuse | ⏳ À activer Q3 2026 | Phase d'observation : auto-promote conservé, tier-grading non bloquant |

### 20.11 Audit & métriques

- **KPI prod stability** : nombre de rollback prod / mois. Cible : 0.
- **KPI vitesse dev** : médiane du délai `push staging → promote main` par tier.
  - Tier 🟢 : < 10 min (auto-promote CI)
  - Tier 🟡 : < 30 min (agent promote autonome après reco)
  - Tier 🔴 : < 1h (agent promote après E2E headfull + monitoring 10 min)
  - Tier 💀 : < 24h (4-yeux + dry-run)
- **KPI précision agent** : % de commits où le tier annoncé correspond
  rétrospectivement à l'impact réel. Si l'agent sous-évalue régulièrement
  (annonce 🟡 mais c'était 🔴), durcir la grille §20.3.
- **KPI veto Robert** : nombre de veto `stop`/`rollback` / mois.
  - Cible : < 1/mois. Au-dessus = signal que l'agent classifie trop bas
    ou que la grille §20.3 a un trou.
  - Chaque veto déclenche un debrief mémoire : pourquoi Robert a vetoé,
    quel pattern ajouter à la grille pour éviter de reproduire.

Audit mensuel : `scripts/ci/audit-promotion-tiers.sh` (à câbler) qui scanne
`git log origin/main` et compte les commits par tier (marker dans le message
post-promotion : `[promoted:low|medium|high|critical]`).

