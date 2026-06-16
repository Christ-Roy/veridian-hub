# [HUB] 🐛 P2 — `resolveTenantByExternalId` sur le hot-path d'ingestion : jusqu'à 3 requêtes DB par event, sans cache

> **Sévérité** : 🟢 P2 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Le trou (prouvé)

`ingestProspectEvent` appelle `resolveTenantByExternalId(input.app, input.workspaceSlug)` à `lib/prospect/ingest.ts:96`, **pour CHAQUE event ingéré, AVANT même de savoir s'il est scorable**.

`resolveTenantByExternalId` (`lib/sync/snapshot-updater.ts:49-99`) fait jusqu'à **3 allers-retours DB séquentiels** par appel :
1. ligne 54-65 : `prisma.tenant.findUnique` si le slug ressemble à un UUID (skip pour un slug Notifuse classique).
2. ligne 68-79 : `prisma.tenant.findFirst({ where: { notifuseWorkspaceSlug } })`.
3. ligne 83-90 : `prisma.$queryRaw` (scan JSONB `metadata -> app ->> 'workspace_id'`) **uniquement si les deux précédents ratent** → c'est le cas pour TOUT workspace orphelin (tenant_uuid jamais résolu).

## Pourquoi c'est un défaut

- **Volume** : `email.opened` est l'event le plus fréquent (un pixel par ouverture, souvent plusieurs par destinataire). Chaque ouverture = 1 à 3 requêtes DB de résolution tenant, sur le chemin critique de la route webhook. À l'échelle d'une campagne cold (milliers de mails), c'est un coût DB linéaire évitable.
- **Pire cas = workspace orphelin** : la spec §7.5 ASSUME que des workspaces orphelins arrivent (`tenant_uuid` NULL = "ingéré pour forensics"). Or l'orphelin est justement le cas qui paie les 3 requêtes (dont le `$queryRaw` JSONB non indexé sur `metadata`). Le cas dégradé est le plus cher. Les "20 orphelins prod" mentionnés dans la SPEC source rendent ce cas réaliste, pas théorique.
- **Résultat jeté** : le `tenantUuid` résolu n'est qu'un champ de dénormalisation pour forensics/dashboards. La même résolution (workspace → tenant) est refaite à chaque event du même workspace, alors qu'elle est **quasi-immuable** (un workspace slug ne change pas de tenant).

## Fix attendu (voie propre)

- **Cache mémoire court (TTL ~60s)** sur `(app, workspaceSlug) → tenantUuid|null`, partagé au niveau process. La résolution tenant est stable ; un TTL d'une minute suffit largement et coupe 99% des requêtes sur une campagne. Garder un negative cache (orphelin) pour ne pas re-scanner le JSONB à chaque event d'un workspace non mappé.
- **Alternative complémentaire** : indexer le lookup JSONB (`CREATE INDEX ... ON tenants USING gin (metadata)` ou un index d'expression sur `metadata -> 'notifuse' ->> 'workspace_id'`) pour que la tentative 3 ne soit pas un seq scan. À évaluer selon le plan réel.
- **Micro-optim** : la résolution tenant pourrait être faite **après** le check de scorabilité, ou en parallèle de l'INSERT event (elle n'est pas requise pour décider du score). Aujourd'hui elle est strictement avant et bloquante.

## Sévérité

🟢 P2 : pas de bug fonctionnel, c'est de la perf/coût DB. Mais c'est sur le hot-path d'une feature dont la raison d'être est le VOLUME (scorer des milliers d'events pour prioriser). À régler avant de brancher un émetteur réel à fort débit, sinon premier point de saturation de la route webhook. Le standard industriel (cf CLAUDE.md §1 "Ajoute une requête SQL → index, pagination, check du plan si >10k rows") l'impose.
