# [HUB] 🔵 P3 — E2E spec 15 Cas 5 : échec au setup fixture (admin create)

> **Sévérité** : 🔵 P3 (échec de fixture E2E, à confirmer si bug réel)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-16 par le team-lead (session promo réconciliateur)

## Symptôme
`e2e/staging-full/15-legacy-tenants-paths.spec.ts` › Cas 5 — « Invitation expirée
+ tenant soft-deleted (cleanup paths) › Trial state machine ignore les tenants
soft-deleted — phase finalize » échoue avec :
`Error: admin create e2e-legacy-trial-soft-finalize-...@e2e.veridian.site`

## Diagnostic (à faire)
L'échec est sur la **création du fixture** (`admin create`), PAS sur l'assertion
métier de la trial state machine. Pistes :
- L'endpoint admin create renvoie une erreur sur ce flow soft-deleted précis
  (collision email déjà soft-deleted ? unique constraint sur email ré-utilisé ?).
- Helper SQL local dupliqué (cf commit 914e52e `E2E_DIRECT_PSQL`) : la fixture
  attend peut-être un accès psql direct non dispo dans ce run.
- Les autres cas de la spec 15 passent → c'est spécifique au Cas 5 (soft-deleted
  + finalize).

## À faire
- [ ] Lire le trace.zip : `pnpm exec playwright show-trace test-results/15-legacy-*Cas-5*/trace.zip`
- [ ] Déterminer si `admin create` échoue à cause d'un vrai bug (réutilisation
      email soft-deleted) ou d'un prérequis de fixture (psql direct).
- [ ] Fixer la fixture OU le endpoint selon le verdict.

## Non bloquant
Les autres cas de la spec 15 + 371/378 du reste passent. La trial state machine
elle-même n'est pas en cause (c'est le setup qui casse). Sans lien avec le
réconciliateur prospect promu cette session.
