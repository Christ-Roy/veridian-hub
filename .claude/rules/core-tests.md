---
paths:
  - "prospection/e2e/core/**"
---

# Tests Core — INTOUCHABLES

Les fichiers dans `prospection/e2e/core/` sont la CONSTITUTION du projet.

## Regles absolues

- **JAMAIS simplifier** un test core. Si un test core fail, le bug est dans le code, pas dans le test.
- **JAMAIS skip** un test core. Pas de `.skip()`, pas de `continue-on-error`, pas de `|| true`.
- **JAMAIS supprimer** un test core sans remplacement equivalent ou meilleur.
- **JAMAIS ajouter** de signup Supabase dans un test core. Login avec comptes existants uniquement.
- **JAMAIS ajouter** de `waitForTimeout` dans un test core. Utiliser `waitForSelector`, `waitForURL`, `waitForLoadState`.

## Pour modifier un test core
1. Expliquer POURQUOI le changement est necessaire (breaking change dans l'app, pas "le test est lent")
2. Le nouveau test doit etre PLUS strict que l'ancien, pas moins
3. Verifier que le test passe 5 fois consecutives avant de commit

## Specs core actuels
- `api-siren.spec.ts` — health check + auth gates API
- `status-endpoint.spec.ts` — /api/status shape, DB connect, perf
- `global-full-flow.spec.ts` — canary "la demo marche" (login → prospects → lead → pipeline → admin)
- `prospects-full-flow.spec.ts` — parcours quotidien Robert complet
- `regression.spec.ts` — sante des 4 services + integrite donnees
- `invited-member-flow.spec.ts` — flow membre invite (le bug de la demo du 6 avril)

## Si un test core fail en CI
Le deploy est BLOQUE. On fixe le code ou le bug, on ne contourne pas le test.
