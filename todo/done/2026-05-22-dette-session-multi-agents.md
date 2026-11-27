# [HUB] Dette technique — session multi-agents 2026-05-21/22

> **Type** : Dette + process improvement
> **Sévérité** : 🟡 P1 (process) + 🟢 P2 (cleanup)
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Contexte** : session intense ~16 agents (Sonnet puis Opus), sprint v1.4
> + suite + perf + E2E + audit. Ce ticket grave ce qui a été bâclé ou fragile.

## 1. Collisions de working tree entre agents (🔴 PROCESS — récurrent)

**Constaté ≥4 fois dans la session** :
- Agent A fait `git add <ses fichiers>`, agent B fait `git commit -am` → embarque le `git add` de A
- Résultat : commits au mauvais subject (`perf(middleware): ...` qui contient aussi du durcissement E2E ; `docs(contract): bump v1.5` qui contient du pricing maillage)
- 4+ agents ont livré du code SANS le commiter (fichiers restés untracked) — j'ai dû les récupérer à la main (specs E2E 10-16, lib/email/templates, backfill script, etc.)

**Cause** : tous les agents tournent dans le MÊME working tree `veridian-hub/`. Le mémo `feedback_worktree_share_with_other_agents` documente le risque mais rien ne l'empêche techniquement.

**Action P1** :
- Option A : un worktree git dédié par agent (`git worktree add`) — isolation réelle
- Option B : sérialiser les agents qui touchent au code (pas de parallèle sur le même repo) — perd le gain de vitesse
- Option C : convention stricte "chaque agent commit AVANT de rendre la main, jamais `git commit -am`, toujours `git add <fichiers explicites>`"
- Reco : **Option A** (worktree par agent) — c'est la seule vraie solution. À câbler dans le spawn des agents.

## 2. Bug livré par un agent, attrapé par un autre (🟡 — qualité)

- L'agent trial-state-machine a livré un 1er commit `8802f58` qui **cassait le build Next.js** (export non-handler depuis route file). Attrapé par un autre agent, refactor en `83b955a`.
- L'agent trial a aussi livré le cron `run-tick` SANS filtre `tenants.deleted_at IS NULL` → activait des trials sur tenants soft-deleted. Bug P1 attrapé par l'agent E2E legacy, fixé en `2a1a12e`.

**Leçon** : un agent seul ne voit pas ses propres trous. Le pattern "agent QA E2E qui teste les vieux tenants / les edge cases" a été **rentable** — il a trouvé 2 bugs réels. À systématiser : tout sprint avec du code business critique = 1 agent QA E2E edge-cases obligatoire en fin.

## 3. CI cassée par un double bloc YAML (🟡 — review manquante)

- Le commit `b761e66` (submodule fix CI) a créé 2 blocs `with:` consécutifs sur `actions/checkout` → workflow Hub Staging fail à 0s "workflow file issue".
- Aucun lint YAML pre-push ne l'a attrapé (le hook check ne lint pas les `.github/workflows/*.yml`).

**Action P2** : ajouter un step lint YAML dans le pre-push hook OU dans un check CI léger (`python3 -c "yaml.safe_load(...)"` sur tous les workflows). 5 min à câbler, évite un CI rouge bête.

## 4. Migrations Prisma pas appliquées en prod automatiquement (🟡 — déjà ticket, rappel)

- Découvert cette session : les 3 migrations sprint v1.4 étaient déployées en CODE mais PAS en DB prod (pas de `prisma migrate deploy` au boot).
- Un agent CI hardening a câblé un job `migrate-prod` (commit `ad7d3de`) — bien. Mais à surveiller que ça tient.
- Le bug `rollback-prod` qui ne se déclenche pas (condition GitHub Actions mal parsée) reste **non fixé** — cf rapport agent CI hardening. **Le filet rollback auto n'est pas fiable.**

**Action P1** : investiguer et fixer la condition du job `rollback-prod` dans `hub-ci.yml`. Le filet de sécurité ne tient pas — si un deploy prod casse, pas de rollback auto.

## 5. composeFile inline Dokploy toujours pas vidé (🟢 — cf reference_dokploy_faux_gitops)

- Le faux GitOps Hub prod : le `composeFile` inline (4097c, image legacy) est ignoré au runtime mais pollue l'UI Dokploy.
- Pas vidé cette session (pas urgent, runtime OK). Reste à faire : `compose.update body={composeFile: ""}`.

## 6. Tests qui passent isolément mais flaky en suite parallèle (🟢)

- Plusieurs fois cette session : un test `__tests__/...` fail dans la run complète mais 100% vert lancé seul (`MembersTable`, `run-tick`, `cross-app-invitation`).
- Cause probable : race entre agents qui écrivent les fichiers pendant que je lance `pnpm test`.
- Pas un vrai bug de test, mais ça brouille le signal. Si ça persiste hors contexte multi-agents → investiguer l'isolation vitest (`pool`, `isolate`).

## 7. 32 tickets todo/ pending, 0 archivés en done/ malgré le sprint (🟢 — hygiène) — ✅ TRAITÉ 2026-05-22

- Le sprint v1.4 a livré ~10 tickets mais `todo/done/` montre 0 archivé (le refresh-todo dit "0 done").
- En réalité plusieurs ont été `mv` vers done/ par les agents (trial-state-machine, api-ref, etc.) mais le compteur est faux ou le scanner rate.
- **Action P2** : passer en revue les 32 tickets pending, archiver ceux réellement livrés (vérifier vs git log), relancer `./scripts/refresh-todo.sh`.

**Fait (Lot 4 dette, commit `d1f17cb`)** : audit vs git log + archivage de 4 tickets
réellement livrés vers `todo/done/` (webhook occurred_at résolu par `f126fa5`,
audit-cross-app doc consommé, audit-perf-hub 3 fix N+1 déjà en done/,
security-audit-followups tous items FIXÉ/VÉRIFIÉ/NOT-A-BUG). `done/` était déjà
non-vide (26 tickets archivés par sprints précédents — le compteur "0 done"
était bien faux). `refresh-todo.sh` relancé.

## 8. 3 trous business cross-app (🔴 P1 — pas Hub, à router)

Audit cross-app `2026-05-21-audit-cross-app-state.md` a flag :
- Prospection : route `/api/refill-leads` absente → **revenu data = 0**
- Prospection : welcome leads grant non câblé → promesse marketing non tenue
- Ces 2 = tickets à déposer dans `veridian-prospection/todo/` et router à l'agent Prospection.

## 9. Pricing : sprint pricing-sync-stripe-products pas attaqué (🟡 P1)

- Le ticket `2026-05-21-pricing-sync-stripe-products.md` (refondre plans.ts + provisionner Stripe Products/Prices LIVE+TEST + endpoint checkout + annual perks) n'a PAS été attaqué cette session.
- Bloque la commercialisation réelle (aucun checkout possible). 4 décisions Robert en attente (Cal.com/Calendly, stack support, etc.).

## 10. Promotion main différée — 31 commits accumulés (🟡 — à arbitrer)

- 31 commits sur staging non promus en main. Pack hétérogène (low/medium/high).
- Tout est testé (972/972), CI staging verte, smoke OK, E2E robustes, audit perf+sécu faits.
- Reco §20 : safe à promouvoir, mais attend le go explicite de Robert (tier 🔴 high dans le pack).

## Synthèse — actions prioritaires prochaine session

| # | Action | Sévérité |
|---|---|---|
| 1 | Worktree git dédié par agent (anti-collision) | 🔴 P1 process |
| 4 | Fixer condition rollback-prod hub-ci.yml | 🔴 P1 |
| 8 | Router 2 tickets refill/welcome leads → agent Prospection | 🔴 P1 |
| 9 | Attaquer pricing-sync-stripe-products (4 décisions Robert d'abord) | 🟡 P1 |
| 3 | Lint YAML workflows en pre-push | 🟢 P2 |
| 7 | Archiver les tickets livrés + refresh-todo | 🟢 P2 |
| 5 | Vider composeFile inline Dokploy | 🟢 P2 |
| 2 | Systématiser agent QA E2E edge-cases en fin de sprint | 🟡 process |

## Ce qui a BIEN marché (à garder)

- Agents Opus partout (la règle a été appliquée après les premiers Sonnet) → qualité nettement meilleure
- Agent QA E2E edge-cases / legacy tenants = a trouvé 2 vrais bugs
- Agent stress/sécu = 0 trou mais confirme la robustesse
- Mode arbitre (review chaque retour, freeze prod) = a catché le bug soft-deleted + le YAML cassé
- check-env-sync hook = a bloqué 2 drifts ENV avant qu'ils partent
