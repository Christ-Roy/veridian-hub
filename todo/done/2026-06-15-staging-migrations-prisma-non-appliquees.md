# [HUB] 🟡 P1 — Les migrations Prisma ne sont PAS appliquées automatiquement sur staging

> **Sévérité** : 🟡 P1 (déploie du code qui plante 500 sur des tables inexistantes)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-15 par le lead Notifuse en livrant le réconciliateur Lot 1.

## Symptôme (vécu)
Push staging du réconciliateur (migration `20260615120000_add_prospect_events_and_scores`)
→ CI "Hub Staging (dev server)" = deploy SUCCESS, container `hub-staging` tourne sur
l'image `staging-37c74ad`. MAIS la table `hub_app.prospect_events` n'existe pas en DB →
`POST /api/webhooks/notifuse` (event comportemental) renvoie **500** :
`The table hub_app.prospect_events does not exist in the current database`.

`_prisma_migrations` staging s'arrête à `20260529180000`. La nouvelle migration n'a
JAMAIS été appliquée.

## Cause
Ni le workflow `.github/workflows/hub-staging.yml`, ni l'entrypoint du container, ne
lancent `prisma migrate deploy`. Le code part déployé, le schéma reste figé. (Note :
`team-orchestration/apps.yml` documente `staging_auto_migrate: true` pour Hub — c'est
FAUX, à corriger aussi.)

## Contournement appliqué (par le lead, pour débloquer le smoke réconciliateur)
Migration appliquée À LA MAIN sur la DB staging :
`docker cp migration.sql hub-staging-db + psql -U hub -d hub -f` + INSERT dans
`_prisma_migrations`. Réconciliateur ensuite validé E2E (ingestion + scoring + idempotence).

## À faire (le vrai fix)
- [ ] Ajouter un step `prisma migrate deploy` dans `hub-staging.yml` APRÈS le déploiement
      (ou dans l'entrypoint du container, avant le `next start`), comme c'est censé l'être.
- [ ] Vérifier le même trou côté PROD Hub (le réconciliateur va y arriver — sans ce fix,
      même 500 en prod). La migration prod devra être appliquée (manuellement ou via le
      step) AVANT que le code réconciliateur n'y soit promu.
- [ ] Corriger `apps.yml` du skill team-orchestration (`staging_auto_migrate: false` pour Hub
      tant que le step n'existe pas).

## Impact réconciliateur
Le code Lot 1 est BON et validé en staging (après application manuelle). Ce ticket est un
trou d'INFRA Hub indépendant, mais BLOQUANT pour la promo prod du réconciliateur.
