# Déploiement gitops Nomad — Hub (SSH-bastion)

> **Ce dossier applique le canon Veridian** documenté en détail dans
> `veridian-prospection/deploy/README.md` (patron de référence arrêté par Robert
> le 2026-07-11 : la CI déploie via SSH vers le bastion Nomad, staging ET prod,
> le `NOMAD_TOKEN` ne quitte jamais le bastion). Lire le canon Prospection pour
> le schéma de flux complet, la justification SSH-bastion, les secrets, le
> rollback et les 11 pièges. Ce README ne documente QUE les différences Hub.

## Fichiers

| Fichier | Rôle |
|---|---|
| `deploy/hub-db.nomad.hcl` | **PROD DB** — job `hub-db`, PostgreSQL `veridian-core-db` stateful, volume local historique `/opt/veridian-lab/hub/core-db`, épinglé `ovh-prod`, port 5432 Tailscale-only, aucun reschedule. |
| `deploy/hub.nomad.hcl` | **PROD app** — job `hub`, app Next.js stateless seule, sert `app.veridian.site`, se connecte au job `hub-db`, canary + auto-revert. `variable image_tag` (défaut `latest`). |
| `deploy/hub-staging.nomad.hcl` | **STAGING** — job `hub-staging`, `provider=ovh-dev`, **DB en cluster Patroni HA** (sidecar HAProxy `pgproxy` → leader dynamique), privé `internal-only@nomad`, sert `hub.staging.veridian.site`. `variable image_tag` (défaut `staging-latest`). |
| `.github/workflows/hub-staging.yml` | Pipeline staging (push `staging`) : build+push GHCR → deploy Nomad SSH-bastion → smoke tailnet. |
| `.github/workflows/hub-ci.yml` | Pipeline prod (push `main`) : test → audit → trivy → docker → deploy-prod (Nomad SSH-bastion) → e2e-prod-smoke. |

## Différences Hub vs canon Prospection

1. **PROD DB séparée du job app.** Le job `hub-db` garde le même volume, le même
   user/db et la même Nomad Variable que l'ancien groupe co-localisé, mais il vit
   seul. Un bump image, un rightsizing ou un restart de l'app `hub` ne redémarre
   donc plus PostgreSQL. La DB reste mono-instance locale tant que la prod n'est
   pas migrée vers Patroni/stockage portable.

2. **PAS de step `prisma migrate deploy` en CI.** Le Hub migre **AU BOOT** du
   container (`Dockerfile` CMD : `prisma migrate deploy && node scripts/init-stripe.mjs
   && node server.js`, CLI Prisma isolé dans `/opt/prisma-cli`, idempotent +
   advisory lock Postgres). Quand Nomad démarre le nouvel alloc, le migrate
   tourne tout seul contre la DB (prod : `hub-db` via Tailscale `100.88.202.29:5432` ;
   staging : le leader Patroni via le sidecar HAProxy) puis lance le serveur.
   → Le pipeline Hub est plus simple que Prospection (pas de container migrate
   éphémère, pas de hop dev-pub pour migrer). Un migrate qui échoue = container
   jamais healthy → `auto_revert` restaure la version saine.

3. **STAGING en Patroni HA** (Prospection staging = postgres mono-instance). La
   DB `hub` vit dans le cluster `hub-staging-db` ; l'app la joint via le sidecar
   HAProxy `pgproxy` (127.0.0.1:5432 → leader courant). DATABASE_URL inchangé.
   Sur failover, HAProxy bascule (shutdown-sessions → le pool Prisma reconnecte).

4. **PLUS de job `rollback-prod` Dokploy.** Remplacé par :
   - `auto_revert = true` (update stanza du job) → restaure auto la dernière
     version saine si le deploy n'atteint jamais healthy.
   - Rollback post-deploy (e2e-prod-smoke rouge sur un alloc pourtant healthy) =
     **manuel §20** : mot-clé `rollback` = `git revert` + push `main` → la CI
     re-déploie le SHA d'avant. Un rollback d'image est safe et quasi-instantané
     (images GHCR à rétention illimitée, re-pullables). Cf canon Prospection §7.

5. **PROD sert `app.veridian.site`** (public, smoke direct) + `hub-lab.veridian.site`.
   La vérif "nouvelle version live" est garantie par le `nomad deployment status
   -monitor` (bloque jusqu'à ce que le NOUVEL alloc soit healthy) — pas besoin
   d'un poll anti-stale séparé comme l'ancien deploy Dokploy.

## Secrets GitHub (repo Hub)

Posés 2026-07-13 (mêmes valeurs partagées cross-app, clé SSH **dédiée Hub**) :

| Secret | Contenu |
|---|---|
| `NOMAD_DEPLOY_SSH_KEY` | Clé SSH privée ed25519 dédiée CI Hub (`hub-ci-deploy@github`). Publique dans `~brunon5/.ssh/authorized_keys` du bastion. |
| `NOMAD_BASTION_HOST` | Adresse du bastion Nomad utilisée comme control-plane. |
| `NOMAD_BASTION_USER` | `brunon5`. |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | (déjà présents) Le smoke staging rejoint le tailnet (staging privé). |

Les secrets **applicatifs** (DB, Stripe, OAuth, HMAC cross-app) vivent dans les
Nomad Variables `nomad/jobs/hub` et `nomad/jobs/hub-staging` — la CI ne les voit
jamais. Les anciens secrets `STAGING_*` / `DEPLOY_SSH_KEY` / `DOKPLOY_*` du deploy
compose sont devenus inutiles (à retirer une fois le Nomad éprouvé).

## Déployer / rejouer à la main (depuis le bastion)

```bash
ssh contabo   # ou déjà dessus
source ~/credentials/nomad-bastion.env
export NOMAD_ADDR NOMAD_TOKEN="$NOMAD_MGMT_TOKEN"

# ⚠️ le HCL DU REPO (déclare variable image_tag), jamais ~/nomad-veridian/jobs/ :
/usr/bin/nomad job validate -var "image_tag=staging-<sha7>" deploy/hub-staging.nomad.hcl
/usr/bin/nomad job plan     -var "image_tag=staging-<sha7>" deploy/hub-staging.nomad.hcl   # exit 1 = normal
/usr/bin/nomad job run -detach -var "image_tag=staging-<sha7>" deploy/hub-staging.nomad.hcl

# prod app (tag = version vX.Y.Z, sans préfixe) :
/usr/bin/nomad job run -detach -var "image_tag=v0.5.<n>" deploy/hub.nomad.hcl

nomad job status hub          # Latest Deployment = successful
curl -s -o /dev/null -w '%{http_code}\n' https://app.veridian.site/api/health   # 200
```

## Cutover PROD stateful/stateless

Ce split est préparé dans Git, mais le cutover du volume est une opération de
fenêtre courte. Ne jamais lancer `hub-db` tant que l'ancien job `hub` contient
encore la task `veridian-core-db` : deux PostgreSQL sur le même volume = risque
de corruption.

Ordre exact :

1. Vérifier live : `nomad-v doctor`, `nomad-v job hub`, `nomad-v raw job inspect -hcl hub`.
2. Sauvegarde fraîche et vérifiée : `/home/brunon5/all-cron/backups/prod-r2-backup.sh`.
3. Copier les deux HCL sur le bastion, puis valider sans mutation :
   `/usr/bin/nomad job validate deploy/hub-db.nomad.hcl` et
   `/usr/bin/nomad job validate -var "image_tag=<tag-live>" deploy/hub.nomad.hcl`.
4. Planifier sans appliquer : `nomad-v plan deploy/hub-db.nomad.hcl`, puis
   `nomad-v raw job plan -var "image_tag=<tag-live>" deploy/hub.nomad.hcl`.
5. Stopper l'ancien job co-localisé `hub` pour libérer le volume.
6. Déployer `hub-db`, attendre `nomad job status hub-db` running et vérifier
   `nc -z -w 5 100.88.202.29 5432`.
7. Déployer `hub` app stateless avec le tag live courant, monitorer le deployment,
   puis smoke `https://app.veridian.site/api/health`.
8. Finir par `nomad-v drift` et une vérification logs Hub sans erreurs DB.

Rollback immédiat avant écriture applicative : arrêter `hub` app stateless,
arrêter `hub-db`, redéployer l'ancien HCL co-localisé depuis le dernier commit
stable ou depuis le miroir Nomad vérifié. Rollback après migration Prisma :
restaurer la sauvegarde validée ou faire un rollback applicatif compatible avec
le schéma déjà migré, selon le contenu de la migration.

## Pièges Hub (en plus des 11 du canon Prospection)

- **Pré-pull staging = sur ovh-dev** (`ssh -n dev-pub docker pull …`) car le job
  `hub-staging` est `provider=ovh-dev`. Pré-pull prod garde **ovh-prod** comme
  nœud préféré historique, même si l'app est désormais stateless. L'auth GHCR
  doit rester valide sur les nœuds éligibles.
- **Migrate-on-boot + Patroni staging** : au démarrage, le container Hub attend
  que le sidecar `pgproxy` route vers un leader. Si l'ordre de démarrage fait
  booter Hub avant pgproxy, le migrate échoue → le `restart` stanza (10×/15s)
  retente jusqu'à ce que pgproxy soit prêt. Self-healing.
