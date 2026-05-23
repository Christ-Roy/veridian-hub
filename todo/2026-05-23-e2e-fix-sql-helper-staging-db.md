# [HUB] E2E fix — SQL exec failed sur hub-staging-db (spec 11)

> **Sévérité** : 🟡 P1 — bloque 2 specs mais probable problème infra plus large
> **Owner** : sub-agent Opus dédié, worktree isolé
> **Créé** : 2026-05-23 par team lead après `pnpm e2e:staging:full`

## Specs en échec

`e2e/staging-full/11-invite-page-ux-flow.spec.ts` S7 :
- "S7 : si crossAppInvitation.acceptedAt est posé, la page rend déjà utilisée"
- Erreur : `SQL exec failed on dev-pub:hub-staging-db`

## Symptôme

Le helper `e2e/staging-full/_sql-helper.ts` n'arrive pas à exec une query SQL contre le container `hub-staging-db` via SSH dev-pub. Probablement :

1. Le helper utilise `ssh dev-pub 'docker exec hub-staging-db psql -U ... -c "..."'` mais l'utilisateur SSH n'a peut-être plus les droits sudo docker, ou le container DB s'appelle autrement maintenant
2. Le mot de passe / utilisateur Postgres est en désync
3. Le container `hub-staging-db` peut être down ponctuellement (Docker stoppé)

## Action attendue

1. Lire `e2e/staging-full/_sql-helper.ts` pour comprendre comment il se connecte
2. Tester la même commande à la main : `ssh dev-pub 'sudo docker exec hub-staging-db psql -U postgres -d hub -c "SELECT 1"'` (ou équivalent selon le helper)
3. Fix le helper si la connexion a changé
4. Re-tester la spec 11
5. **Si problème affecte aussi spec 10** (trial state machine), partager le fix avec l'autre agent

## Note

Ce ticket pourrait être la cause racine de plusieurs autres fails. Si le helper SQL est cassé, toutes les specs qui insèrent/modifient des rows en DB pour leur setup vont échouer.

## Contraintes

- Pas de modif compose Stripe/billing
- Marker `[risk:low]` (helper test only)
- Si tu modifies `lib/`, tests Nuclear
