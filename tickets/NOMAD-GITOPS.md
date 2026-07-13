# TICKET — Passer hub en GitOps Nomad propre

> Ticket standard déposé par l'infra (repo `nomad-veridian`). À traiter par l'agent dédié de
> CE repo quand il se réveille. Objectif : niveau de propreté "boîte établie" — le déploiement
> de hub vit DANS ce repo (gitops), tourne en **job Nomad** (plus de compose/Dokploy), et
> respecte les règles strictes de l'infra. **Le terrain a raison** : vérifie l'état réel avant d'agir.

## Contexte (déjà fait par l'infra)
- Migration Dokploy → **cluster Nomad 3 nœuds** TERMINÉE. hub tourne DÉJÀ en job Nomad
  (`~/nomad-veridian/jobs/hub.nomad.hcl`, déployé, sain). Dokploy est décommissionné.
- Contrôle-plane sur le bastion Contabo. Pilotage : `source ~/credentials/nomad-bastion.env;
  export NOMAD_ADDR NOMAD_TOKEN` puis `nomad ...` / wrapper `nomad-v` / `nomad-v state` (dashboard).
- Conventions + invariants : `~/nomad-veridian/CLAUDE.md`. Templates : `~/nomad-veridian/jobs/templates/`.

## Ce qu'on veut (Definition of Done)
1. **Le job Nomad de hub vit dans CE repo** (ex `deploy/hub.nomad.hcl`), source de vérité gitops —
   pas seulement dans `nomad-veridian`. Aligne-le sur le job réellement déployé (copie-le, adapte).
2. **CI de déploiement** (GitHub Actions) : sur push de la branche de prod (après build+tests+scan
   sécu existants), la CI fait `nomad job run` du job (via NOMAD_ADDR/NOMAD_TOKEN en secrets repo,
   Tailscale runner ou token). Comme l'ancien gitops Dokploy, mais vers Nomad. `nomad job plan` avant.
3. **Job conforme aux règles infra** (NON négociables) :
   - **Réseau privé par défaut** : tout port en `host_network = "tailscale"` (bind Tailscale-only).
     **JAMAIS `0.0.0.0` / port public arbitraire** — un hook harness bloque déjà `docker -p 0.0.0.0`.
     Seul l'ingress (Traefik, 80/443) est public ; hub est joignable UNIQUEMENT via l'ingress.
   - Exposition web via **tags Traefik** (routers web+websecure, `tls.certresolver=letsencrypt`) :
     public client → `crowdsec@file`+`securityheaders@file` (hérités) ; interne/staging → middleware
     `internal-only@nomad` (ipAllowList 100.64/10 → 403 hors tailnet).
   - **Secrets** : Nomad Variable `nomad/jobs/hub` + `template{env=true}`. JAMAIS en clair dans le HCL/repo.
   - Tout job déclare `resources` (jamais unbounded), `restart`+`reschedule`, un `check`, une `priority`,
     un placement (`constraint ${meta.provider}` + node pool). Cf `jobs/templates/README.md`.
4. **DB en HA (si hub a une base Postgres)** : cible = cluster **Patroni** (failover auto via Consul),
   plus de postgres co-localisé mono-instance. Gabarit prouvé bout-en-bout :
   `~/nomad-veridian/jobs/hub-staging-db.nomad.hcl` (cluster) + `hub-staging.nomad.hcl` (app + sidecar
   HAProxy qui suit le leader, DATABASE_URL `@127.0.0.1:5432` inchangé). Pièges dans la mémoire
   `patroni-failover-proto` (dump via `docker exec`+`docker cp` PAS `nomad alloc exec` qui tronque ;
   stripper `\restrict` ; prouver le failover via psql dans le netns, pas `/api/health`).
   ⚠️ Migration d'une DB PROD = **downtime court + backup all-cron FRAIS vérifié avant + rollback prêt**.
   Coordonne avec l'infra / Robert pour la fenêtre si hub est critique/client-payant.

## Comment procéder
1. Lis `~/nomad-veridian/CLAUDE.md` + `jobs/templates/README.md` + le job actuel `jobs/hub.nomad.hcl`.
2. Rapatrie le job dans ce repo (`deploy/`), vérifie conformité (règles ci-dessus), `nomad job validate`.
3. Câble la CI de déploiement (secrets repo, plan→run).
4. Si DB → planifie la bascule Patroni (staging d'abord si tu en as un, prod sur fenêtre).
5. Teste, documente, ferme ce ticket.

## Garde-fous
- Ne casse pas la prod : `nomad job plan` avant tout `run`, vérifie `nomad-v state` après.
- Rien en clair (secrets). Rien de public arbitraire (Tailscale only). `git` : PR plutôt que push direct sur main si CI de déploiement.
- En cas de doute sur un arbitrage prod / dépense / fenêtre → remonte, ne devine pas.

---

## ✅ CANON PROUVÉ — prospection l'a fait le 2026-07-12, COPIE-LE (ne réinvente pas)

prospection a livré **et validé end-to-end** (CI verte, bon SHA déployé, `/api/health`=200)
le **premier** pipeline gitops Nomad SSH-bastion. C'est LE patron de référence.

### Référence à lire/copier (repo `veridian-prospection`)
- **`deploy/README.md`** — runbook complet : schéma de flux, secrets, rollback, migrations, **11 pièges**,
  et une section §10 « comment une AUTRE app copie ce patron ». **Lis-le en premier.**
- `deploy/prospection.nomad.hcl` (prod) + `deploy/prospection-staging.nomad.hcl` (staging) — jobs
  versionnés avec `variable "image_tag"` + stanza `update` (cf piège 1).
- `.github/workflows/prospection-deploy-staging.yml` (job `deploy`) et `prospection-ci.yml`
  (job `deploy-prod`) — les 2 jobs CI à copier-adapter.

### Secrets GH PARTAGÉS (déjà posés, cross-app — RÉUTILISE, ne recrée pas)
`NOMAD_DEPLOY_SSH_KEY` (clé CI dédiée, sa publique est dans `~brunon5/.ssh/authorized_keys` du bastion),
`NOMAD_BASTION_HOST=75.119.158.217`, `NOMAD_BASTION_USER=brunon5`. (`CR_PAT` reste requis pour le
submodule privé `veridian-infra` sur les checkouts `submodules: recursive` + login GHCR.)

### Prérequis NODE one-shot : `docker login ghcr` pour ROOT sur chaque nœud
Nomad **ne pull pas les images privées ghcr** (son plugin docker n'a pas de bloc `auth`) → sans ça,
l'alloc reste `pending` → 502. Vérifié posé sur **ovh-dev + bastion**. Pour un autre nœud :
`sudo cp ~<user>/.docker/config.json /root/.docker/config.json` (le user SSH y a déjà l'auth).

### Les 4 PIÈGES qui ont coûté 6 itérations CI à prospection — évite-les d'emblée
1. **`update { healthy_deadline = "15m", progress_deadline = "20m", auto_revert = true }`** sur le
   group. Le 1er pull de l'image sur un nœud sans cache dépasse les **5min par défaut** → deployment
   marqué `failed` alors que l'app finit de démarrer (incident 502). `auto_revert` = filet de sécurité.
2. **Pré-pull authentifié de l'image sur le nœud cible AVANT `nomad job run`** (staging via
   `ssh -n dev-pub 'docker pull …'`, prod via `docker pull` local sur le bastion). Sinon Nomad lève
   un `401 unauthorized` sur l'image privée.
3. **`ssh -n` OBLIGATOIRE** pour tout `ssh` dans un heredoc (pré-pull, rm/scp du migrate) : sans `-n`,
   le ssh **lit le stdin du heredoc et AVALE les commandes `nomad job run` suivantes** → elles ne
   s'exécutent jamais (CI verte mais ancienne version live = **faux vert silencieux**).
4. **Vérif du deploy = `nomad deployment status -monitor <DeploymentID>` CIBLÉ** — PAS le poll
   `nomad job status | grep successful` (faux **positif** : lit le "successful" de l'ANCIEN
   déploiement) NI `nomad job run` bloquant (faux **négatif** : `404 deployment not found` transitoire).
   Résous le `DeploymentID` via l'`Evaluation ID` renvoyé par `nomad job run -detach` (petit retry).

### Ce que TU adaptes pour ton app
- `constraint ${meta.provider}` : `contabo` (bastion = prod/ingress) ou `ovh-dev` (staging). Vérifie
  où ton alloc tourne (`nomad job status <ton-job>`).
- Tag image : staging = `staging-<sha7>`, prod = `<sha7>` **sans** préfixe (cf `docker/metadata-action`).
- Migrate : container DB `db-<alloc>` (co-localisé) ou externe/Patroni selon ton cas ; `ssh -n` !
- Smoke : via **tailnet** si privé (`internal-only@nomad`), **direct** si public.
- DB co-localisée mono-instance → cible **Patroni HA** à terme (`nomad-veridian/tickets/TICKET-001`).

> Tout le détail (rollback par tag/`job revert`, deploy manuel, cleanup post-Dokploy) est dans
> **`veridian-prospection/deploy/README.md`**. En cas de doute prod / fenêtre → remonte à Robert.
