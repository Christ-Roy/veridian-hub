# MEGA E2E — Runbook opérationnel

> Suite Playwright bout-en-bout post-commercialisation Hub.
> Source de vérité périmètre : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md`.

---

## Vue d'ensemble

| Aspect | Valeur |
|---|---|
| **Suite** | `e2e/staging-full/mega/` — 24 buckets (A→M) |
| **Cible** | `https://hub.staging.veridian.site` (override `STAGING_URL`) |
| **Config Playwright** | `playwright.mega.config.ts` (workers=4 CI, 2 local) |
| **Trigger** | Manuel agent (`pnpm e2e:mega`) avant promo prod tier 🔴/💀 |
| **Durée** | ~20-30 min (cible CI hard cap 30 min) |
| **Cleanup** | 3 niveaux (`afterEach` + `afterAll` + `globalTeardown`) + filet humain |

---

## Quick start

### 1. Pré-check infra

```bash
pnpm e2e:mega:precheck
# ou : bash scripts/e2e/mega-precheck.sh
```

Vérifie 7 conditions : staging up, mock OAuth listé, SSH dev-pub, DBs Hub
+ Notifuse + Prospection accessibles, Stripe TEST key + `head_office` FR.

Si une condition fail → fix l'infra avant de lancer la suite (sinon 20 min
gaspillées pour un timeout SSH au premier test).

### 2. Lancer la suite

```bash
# Suite complète (workers parallèles)
pnpm e2e:mega

# Un bucket précis (debug ciblé)
pnpm e2e:mega --grep "Mega A"        # bucket A (onboarding)
pnpm e2e:mega --grep "Mega C"        # bucket C (billing checkout)

# Smoke fixtures uniquement (validation Vague 1)
pnpm e2e:mega --grep "_smoke"

# Mode visuel (debug, slow-motion)
HEADED=1 pnpm e2e:mega --grep "Mega A 01"

# Override URL cible (tester sur une autre instance)
STAGING_URL=https://hub.preprod.veridian.site pnpm e2e:mega
```

### 3. Lire les résultats

À la fin du run, l'output contient :

- **Récap structuré** : pass/fail par bucket (parseable par formatter agent)
- **HTML report** : `playwright-report-mega/index.html` (debug interactif)
- **JSON report** : `e2e-mega-staging.json` (parsing CI / agent)
- **Traces** : `test-results/<test-name>/trace.zip` (replay Playwright)
- **Récap globalTeardown** : counts purgés (Stripe, DBs), résidus restants

### 4. Cleanup manuel (si nécessaire)

Le `globalTeardown` purge automatiquement après chaque run, mais si :

- tu as interrompu le run avec Ctrl+C
- le globalTeardown a failed partiellement
- tu vois des résidus dans la DB Hub

```bash
# Purge complète (Stripe + DBs)
pnpm e2e:mega:purge

# Dry-run (liste sans supprimer)
bash scripts/e2e/mega-purge.sh --dry-run

# Stripe uniquement (DBs intactes)
bash scripts/e2e/mega-purge.sh --stripe-only

# DBs uniquement (Stripe intact)
bash scripts/e2e/mega-purge.sh --db-only
```

---

## Architecture de la suite

### Layout des fichiers

```
e2e/staging-full/mega/
├── README.md                       ← convention + layout
├── _fixtures/
│   ├── run-stamp.ts                ← MEGA_RUN_STAMP unique par run
│   ├── mock-oauth.ts               ← megaSignIn(), megaEmail()
│   ├── stripe-card.ts              ← fillStripeCheckout(), cards test
│   ├── stripe-api.ts               ← cleanupAllMegaArtifacts(), Stripe SDK
│   ├── db-purge.ts                 ← purgeMegaByPrefix(), countMegaResidues()
│   ├── downstream-db.ts            ← getNotifuseWorkspace(), getProspectionWorkspace()
│   ├── perf-budget.ts              ← measure(), checkPerfBudget()
│   ├── audit-log.ts                ← findAuditEntries(), assertAuditEntry()
│   ├── _global-teardown.ts         ← cleanup final post-run
│   └── _smoke.spec.ts              ← validation Vague 1 (run en 1er)
├── A-onboarding/                   ← 5 specs (Vague 2)
├── B-trial/                        ← 3 specs (Vague 2)
├── C-billing-checkout/             ← 5 specs (Vague 2)
├── D-plan-changes/                 ← 4 specs (Vague 2)
├── E-refill-leads/                 ← 2 specs (Vague 2)
├── F-webhook-robustness/           ← 4 specs (Vague 2)
├── G-cross-app-sync/               ← 3 specs (Vague 2)
├── H-invitations-oauth-bounce/     ← 3 specs (Vague 2)
├── I-security/                     ← 4 specs (Vague 2)
├── J-gdpr/                         ← 1 spec (Vague 2)
├── K-race-conditions/              ← 2 specs (Vague 2)
├── L-performance/                  ← 2 specs (Vague 2)
└── M-rollback/                     ← 1 spec optionnel (Vague 2)
```

### Cleanup 3 niveaux

```
┌─────────────────────────────────────────────────────────────┐
│ Niveau 1 : test.afterEach (par test)                       │
│   → close Playwright context (BrowserContext + APIRequest) │
│   → ~1ms / test                                             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Niveau 2 : test.afterAll (par spec)                        │
│   → purgeMegaByPrefix({ emailPrefix, tenantPrefix })       │
│   → ~700ms / spec (1 SSH roundtrip)                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Niveau 3 : globalTeardown (fin de run, GARANTI)            │
│   → cleanupAllMegaArtifacts() (Stripe customers + subs)    │
│   → purgeAllMegaArtifacts() (DB Hub e2e-mega-%)            │
│   → purgeNotifuseMega() + purgeProspectionMega()           │
│   → pkill chromium / playwright orphelins                  │
│   → countMegaResidues() (vérif finale = 0)                 │
│   → ~5-10 secondes                                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ FILET HUMAIN : scripts/e2e/mega-purge.sh                   │
│   → Idempotent, safe à relancer 10× sans rien casser       │
│   → À utiliser si Ctrl+C, fail globalTeardown, etc.        │
└─────────────────────────────────────────────────────────────┘
```

### Isolation tenant

Chaque test crée son propre tenant unique :

- **Email** : `e2e-mega-<bucket>-<spec>-<RUN_STAMP>-<variant>@e2e.veridian.site`
- **TenantId** : `mega-<bucket>-<RUN_STAMP>-<slug>`
- **RUN_STAMP** : `<timestamp-ms>-<random>` unique par invocation Playwright

→ **Aucune collision** entre 4 workers parallèles, ni entre 10 runs simultanés.

---

## Helpers `_fixtures/`

### `mock-oauth.ts`

```ts
import { megaSignIn, disposeSession, type MegaSession } from './_fixtures/mock-oauth';

let session: MegaSession;

test.beforeEach(async ({ playwright }) => {
  session = await megaSignIn(playwright, {
    bucket: 'A',
    spec: '01-signup-oauth-google',
    provider: 'google',
  });
});

test.afterEach(async () => {
  await disposeSession(session);
});
```

### `stripe-card.ts`

```ts
import { fillStripeCheckout, STRIPE_TEST_CARDS } from './_fixtures/stripe-card';

await fillStripeCheckout(page, { card: 'success' });
await fillStripeCheckout(page, { card: '3ds-required' });
await fillStripeCheckout(page, { card: 'decline' });
```

### `db-purge.ts`

```ts
import { purgeMegaByPrefix } from './_fixtures/db-purge';

test.afterAll(async () => {
  await purgeMegaByPrefix({
    emailPrefix: 'e2e-mega-a-01',
    tenantPrefix: 'mega-a',
  });
});
```

### `audit-log.ts`

```ts
import { assertAuditEntry, assertAuditCount, assertNoAuditEntry } from './_fixtures/audit-log';

const entry = await assertAuditEntry({
  action: 'billing.checkout.completed',
  targetIdLike: 'mega-c-01-%',
});
expect(entry.payload).toMatchObject({ plan: 'notifuse-pro' });
```

### `perf-budget.ts`

```ts
import { checkPerfBudget } from './_fixtures/perf-budget';

await checkPerfBudget({
  label: 'GET /api/billing/state',
  iterations: 50,
  warmup: 5,
  fn: () => fetch(`${url}/api/billing/state`),
  budget: { p95: 100, p99: 200 },
});
```

### `downstream-db.ts`

```ts
import { getNotifuseWorkspace, getProspectionWorkspace } from './_fixtures/downstream-db';

const notifWs = getNotifuseWorkspace('mega-c-01-12345-fresh');
expect(notifWs?.veridian_plan).toBe('pro');
```

### `stripe-api.ts`

```ts
import { getCustomerByEmail, listSubsForCustomer } from './_fixtures/stripe-api';

const customer = await getCustomerByEmail(session.email);
expect(customer).not.toBeNull();
const subs = await listSubsForCustomer(customer!.id);
expect(subs).toHaveLength(1);
expect(subs[0].status).toBe('active');
```

---

## Debug

### Spec rouge en CI

1. **Lire le JSON report** : `e2e-mega-staging.json` (ou parser via
   `format-staging-report.js`).
2. **Ouvrir le HTML report** : `playwright-report-mega/index.html` →
   replay du test avec traces.
3. **Reproduire en local** :
   ```bash
   HEADED=1 pnpm e2e:mega --grep "<nom du test exact>"
   ```
4. **Si flake (1 fail isolé sur 10 runs)** : ajouter `waitForSelector`
   ou augmenter `expect.timeout`. Documenter dans le ticket source.
5. **Si bug réel (2+ fails)** : fix le code + le test, re-push staging.

### Résidus DB après le run

```bash
# Compter
ssh dev-pub 'docker exec -i hub-staging-db psql -U hub -d hub -tA -c "
  SELECT
    (SELECT count(*) FROM hub_app.users WHERE email LIKE '\''e2e-mega-%'\'') AS users,
    (SELECT count(*) FROM hub_app.tenants WHERE slug LIKE '\''mega-%'\'') AS tenants;
"'

# Purger
pnpm e2e:mega:purge
```

### Stripe customers test orphelins

```bash
# Liste via Stripe CLI (si installé)
stripe customers list --limit 100 --api-key=$STRIPE_SECRET_KEY_TEST \
  | jq '.data[] | select(.email | test("e2e-mega-")) | .id'

# Purge via script MEGA
bash scripts/e2e/mega-purge.sh --stripe-only
```

---

## Garde-fous anti-régression

| Risque | Garde-fou |
|---|---|
| Test tape la prod par accident | `mock-oauth.ts:assertStagingUrl()` refuse toute URL non staging |
| Clé Stripe LIVE utilisée par cleanup | `stripe-api.ts:getStripe()` refuse si pas `sk_test_*` |
| Purge wipe la DB | `db-purge.ts:assertSafe*Prefix()` exige `e2e-mega-` / `mega-` strict |
| Mock OAuth shippé en prod | `scripts/ci/check-no-test-provider-in-prod.sh` (déjà en place) |
| Bombe temporelle (Date.now hardcoded) | Convention : back-date via `_sql-helper.ts:backdateTrialActive()` |
| Bombe `NODE_ENV` (toujours `production` en build) | Convention : utiliser `DEPLOY_ENV` strict |

---

## Vague 1 livrée (2026-05-24)

- Layout `e2e/staging-full/mega/` + 13 sous-dossiers buckets
- 7 helpers `_fixtures/` (mock-oauth, stripe-card, stripe-api, db-purge,
  downstream-db, perf-budget, audit-log)
- `_global-teardown.ts` (cleanup Stripe + DBs + procs)
- `_smoke.spec.ts` (5 tests qui valident les helpers tournent)
- `playwright.mega.config.ts` (workers parallèles, globalTeardown câblé)
- 3 scripts `scripts/e2e/` : `mega.sh`, `mega-precheck.sh`, `mega-purge.sh`
- 4 scripts `package.json` : `e2e:mega`, `e2e:mega:bucket`,
  `e2e:mega:precheck`, `e2e:mega:purge`
- Runbook `docs/E2E-MEGA-RUNBOOK.md` (ce fichier)

---

## Vagues à venir (autres agents)

- **Vague 2** (6 agents parallèles) : 24+ specs métier (A→M). Cf. ticket
  racine §8.
- **Vague 3** (1 agent) : workflow CI `hub-mega-e2e.yml` + extension
  formatter pour parser buckets MEGA.
- **Vague 4** (optionnel) : monitoring Grafana metrics, alerting flake
  rate, cron quotidien sub-suite critique.

---

## Références

- Ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md`
- Specs existantes absorbées : `e2e/staging-full/01-..16-*.spec.ts`
- Helpers historiques : `e2e/staging-full/_helpers.ts`, `_sql-helper.ts`
- Contrats : `docs/CONTRAT-HUB.md`, `docs/CONTRAT-BILLING.md`,
  `docs/PRICING-VERIDIAN.md`
- CI-ARCHITECTURE §20 (protocole risk markers) : `docs/CI-ARCHITECTURE.md`
- Memory référence mock OAuth : `~/.claude/projects/.../memory/reference_mock_oauth_provider.md`
