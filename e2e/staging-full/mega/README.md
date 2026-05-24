# MEGA E2E suite — `e2e/staging-full/mega/`

> Suite Playwright bout-en-bout post-commercialisation. Couvre 24 buckets
> de flows critiques (onboarding, trial, billing, plan changes, refill,
> webhook robustness, cross-app sync, invitations, security, GDPR, race
> conditions, perf, rollback).
>
> Source de vérité du périmètre : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md`.

## Layout

```
mega/
├── README.md                   ← ce fichier
├── _fixtures/                  ← helpers réutilisables (Vague 1)
│   ├── mock-oauth.ts           ← signup OAuth mock cross-bucket
│   ├── stripe-card.ts          ← Stripe Checkout helpers (carte test, 3DS)
│   ├── stripe-api.ts           ← Stripe SDK wrapper preprod (cleanup, replay)
│   ├── db-purge.ts             ← purge DB Hub par préfixe `e2e-mega-*`
│   ├── downstream-db.ts        ← SSH dev-pub + psql Notifuse/Prospection
│   ├── perf-budget.ts          ← timer p50/p95/p99 avec assert budget
│   ├── audit-log.ts            ← query `hub_app.audit_log` par tenant/action
│   ├── _global-teardown.ts     ← cleanup final post-run (Stripe + DBs + procs)
│   └── _smoke.spec.ts          ← UN test qui valide les helpers tournent
├── A-onboarding/               ← Vague 2 (5 specs)
├── B-trial/                    ← Vague 2 (3 specs)
├── C-billing-checkout/         ← Vague 2 (5 specs)
├── D-plan-changes/             ← Vague 2 (4 specs)
├── E-refill-leads/             ← Vague 2 (2 specs)
├── F-webhook-robustness/       ← Vague 2 (4 specs)
├── G-cross-app-sync/           ← Vague 2 (3 specs)
├── H-invitations-oauth-bounce/ ← Vague 2 (3 specs)
├── I-security/                 ← Vague 2 (4 specs)
├── J-gdpr/                     ← Vague 2 (1 spec)
├── K-race-conditions/          ← Vague 2 (2 specs)
├── L-performance/              ← Vague 2 (2 specs)
└── M-rollback/                 ← Vague 2 (1 spec, optionnel CI)
```

## Comment lancer

```bash
# Pré-check infra (staging up, Stripe TEST OK, ssh dev-pub OK)
bash scripts/e2e/mega-precheck.sh

# Suite complète (workers parallèles, ~20-30 min)
pnpm e2e:mega

# Un bucket précis (debug ciblé)
pnpm e2e:mega --grep "Mega A"

# Mode headfull (debug visuel)
HEADED=1 pnpm e2e:mega --grep "_smoke"

# Cleanup manuel post-incident (filet humain)
bash scripts/e2e/mega-purge.sh
```

## Convention universelle

Tous les scénarios respectent :

- **Email** : `e2e-mega-<bucket>-<spec>-<RUN_STAMP>@e2e.veridian.site`
- **TenantId** : `mega-<bucket>-<RUN_STAMP>-<slug>`
- **`test.afterEach`** : ferme `BrowserContext` + `APIRequestContext`
- **`test.afterAll`** : purge rows DB Hub matching préfixe (idempotent)
- **`globalTeardown`** : purge Stripe customers test + DB Hub/Notifuse/Prospection (cross-spec)

## Cleanup 3 niveaux

| Niveau | Où | Quand | Quoi |
|---|---|---|---|
| 1 | `test.afterEach` | Après chaque test | Ferme contexts Playwright |
| 2 | `test.afterAll` | Après chaque spec | DELETE rows DB Hub par préfixe spec |
| 3 | `globalTeardown` | Fin de run (même si crash) | Stripe + DBs cross-app + procs orphelins |

Filet humain : `scripts/e2e/mega-purge.sh` (idempotent, safe à relancer).

## Garde-fous

- **Isolation tenant** : 1 tenant unique par scénario → workers parallèles safe
- **Pas de bombe temporelle** : back-date via SQL helper, jamais `vi.useFakeTimers`
- **Cleanup `try/catch`** : ne JAMAIS throw dans afterEach/afterAll
- **`DEPLOY_ENV`** : jamais NODE_ENV (cf. `feedback_node_env_vs_deploy_env`)
- **Mock OAuth** : guard `OAUTH_TEST_PROVIDER=true` + `DEPLOY_ENV !== prod`
- **Préfixe email/tenant** : strict regex `e2e-mega-*` côté purge (zéro
  collision avec users réels)

## Périmètre Vague 1 livré

- Layout (ce dossier + README)
- 7 helpers `_fixtures/`
- `playwright.mega.config.ts` (workers=4 grâce à l'isolation tenant)
- 3 scripts : `mega.sh`, `mega-precheck.sh`, `mega-purge.sh`
- `_global-teardown.ts` (cleanup 3 niveaux)
- `_smoke.spec.ts` (valide que les helpers tournent + cleanup OK)
- Script `pnpm e2e:mega` + `pnpm e2e:mega:bucket` ajoutés à `package.json`
- Runbook `docs/E2E-MEGA-RUNBOOK.md`

## Vagues 2/3/4 (autres agents)

- **Vague 2** (6 agents parallèles) : 24+ specs métier (A→M)
- **Vague 3** (1 agent) : workflow CI `hub-mega-e2e.yml` + formatter
- **Vague 4** (optionnel) : monitoring Grafana, alerting flake rate

## Référence

- Ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md`
- E2E existant absorbé : `e2e/staging-full/01-..16-*.spec.ts`
- Helpers historiques réutilisés : `e2e/staging-full/_helpers.ts`, `_sql-helper.ts`
- Convention rate-limit bypass : `_helpers.ts:bypassRateLimitHeaders()`
- Contrats : `docs/CONTRAT-HUB.md`, `docs/CONTRAT-BILLING.md`, `docs/PRICING-VERIDIAN.md`
