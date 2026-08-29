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
| `deploy/hub.nomad.hcl` | **PROD** — job `hub`, `provider=ovh-prod`, DB `veridian-core-db` postgres:16 co-localisée, sert `app.veridian.site`. `variable image_tag` (défaut `latest`). |
| `deploy/hub-staging.nomad.hcl` | **STAGING** — job `hub-staging`, `provider=ovh-dev`, **DB en cluster Patroni HA** (sidecar HAProxy `pgproxy` → leader dynamique), privé `internal-only@nomad`, sert `hub.staging.veridian.site`. `variable image_tag` (défaut `staging-latest`). |
| `.github/workflows/hub-staging.yml` | Pipeline staging (push `staging`) : build+push GHCR → `put-job` / `deploy` / `cleanup` sur le bastion → smoke tailnet. |
| `.github/workflows/hub-ci.yml` | Pipeline prod (push `main`) : test → audit → trivy → docker → deploy-prod (`put-job` / `deploy` / `cleanup` sur le bastion) → e2e-prod-smoke. |

## Différences Hub vs canon Prospection

1. **PAS de step `prisma migrate deploy` en CI.** Le Hub migre **AU BOOT** du
   container (`Dockerfile` CMD : `prisma migrate deploy && node scripts/init-stripe.mjs
   && node server.js`, CLI Prisma isolé dans `/opt/prisma-cli`, idempotent +
   advisory lock Postgres). Quand Nomad démarre le nouvel alloc, le migrate
   tourne tout seul contre la DB (prod : `veridian-core-db` en 127.0.0.1:5432 ;
   staging : le leader Patroni via le sidecar HAProxy) puis lance le serveur.
   → Le pipeline Hub est plus simple que Prospection (pas de container migrate
   éphémère, pas de hop dev-pub pour migrer). Un migrate qui échoue = container
   jamais healthy → `auto_revert` restaure la version saine.

2. **STAGING en Patroni HA** (Prospection staging = postgres mono-instance). La
   DB `hub` vit dans le cluster `hub-staging-db` ; l'app la joint via le sidecar
   HAProxy `pgproxy` (127.0.0.1:5432 → leader courant). DATABASE_URL inchangé.
   Sur failover, HAProxy bascule (shutdown-sessions → le pool Prisma reconnecte).

3. **PLUS de job `rollback-prod` Dokploy.** Remplacé par :
   - `auto_revert = true` (update stanza du job) → restaure auto la dernière
     version saine si le deploy n'atteint jamais healthy.
   - Rollback post-deploy (e2e-prod-smoke rouge sur un alloc pourtant healthy) =
     **manuel §20** : mot-clé `rollback` = `git revert` + push `main` → la CI
     re-déploie le SHA d'avant. Un rollback d'image est safe et quasi-instantané
     (images GHCR à rétention illimitée, re-pullables). Cf canon Prospection §7.

4. **PROD sert `app.veridian.site`** (public, smoke direct) + `hub-lab.veridian.site`.
   La vérif "nouvelle version live" est garantie par le `nomad deployment status
   -monitor` (bloque jusqu'à ce que le NOUVEL alloc soit healthy) — pas besoin
   d'un poll anti-stale séparé comme l'ancien deploy Dokploy.

## Secrets GitHub (repo Hub)

Posés 2026-07-13 (mêmes valeurs partagées cross-app, clé SSH **dédiée Hub**) :

| Secret | Contenu |
|---|---|
| `NOMAD_DEPLOY_SSH_KEY` | Clé SSH privée ed25519 dédiée CI Hub (`hub-ci-deploy@github`). Publique dans `~brunon5/.ssh/authorized_keys` du bastion, **en commande forcée** `command="/usr/local/sbin/veridian-ci-deploy hub"` : elle n'ouvre plus de shell. |
| `NOMAD_BASTION_HOST` | Adresse du bastion Nomad utilisée comme control-plane. |
| `NOMAD_BASTION_USER` | `brunon5`. |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | (déjà présents) Le smoke staging rejoint le tailnet (staging privé). |

Les secrets **applicatifs** (DB, Stripe, OAuth, HMAC cross-app) vivent dans les
Nomad Variables `nomad/jobs/hub` et `nomad/jobs/hub-staging` — la CI ne les voit
jamais. Les anciens secrets `STAGING_*` / `DEPLOY_SSH_KEY` / `DOKPLOY_*` du deploy
compose sont devenus inutiles (à retirer une fois le Nomad éprouvé).

## Contrat de déploiement contraint (constat C4)

La clé de CI ouvrait un shell sur un compte `NOPASSWD:ALL` du groupe `docker` :
elle valait root sur le bastion et pouvait lire `~/credentials/nomad-bastion.env`,
c'est-à-dire le jeton **management** Nomad, c'est-à-dire les secrets de toutes les
applications. Elle porte désormais une commande forcée, et la CI ne parle plus au
bastion qu'en verbes validés :

| Étape CI | Commande envoyée |
|---|---|
| dépôt du jobspec | `ssh … "put-job <staging\|prod>" < deploy/hub[-staging].nomad.hcl` (le HCL passe par stdin ; refusé s'il ne déclare pas le job attendu) |
| déploiement | `ssh … "deploy <tier> <image_tag>"` |
| nettoyage | `ssh … "cleanup <tier>"` |

L'application (`hub`) est fixée **dans la ligne de la clé**, côté serveur : cette
clé ne peut pas déployer une autre application, et le tag doit matcher
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Tout le reste sort en code **64**.

Ce que le script serveur (`/usr/local/sbin/veridian-ci-deploy`) exécute pour nous,
et qu'il ne faut donc PAS redupliquer dans les workflows : sauvegarde R2
pré-déploiement des bases (pré-hook du couple `hub`/`prod`), pré-pull authentifié
sur le nœud cible, `nomad job validate`, `nomad job plan` avec traitement de son
code retour, `nomad job run -detach -check-index` (anti-TOCTOU), puis suivi du
DeploymentID exact jusqu'à son état terminal. Le garde-fou
`scripts/ci/check-prod-gitops-reliability.sh` refuse la réintroduction d'un
`bash -s`, d'une lecture du jeton ou d'un appel `nomad` brut depuis la CI.

Toujours `-o BatchMode=yes`, jamais `-t` : la clé est en `no-pty`.

Retour arrière : retirer `command="…"` de la ligne concernée dans
`~brunon5/.ssh/authorized_keys` du bastion.

## Déployer / rejouer à la main (depuis le bastion)

```bash
ssh contabo   # ou déjà dessus
source ~/credentials/nomad-bastion.env
export NOMAD_ADDR NOMAD_TOKEN="$NOMAD_MGMT_TOKEN"

# ⚠️ le HCL DU REPO (déclare variable image_tag), jamais ~/nomad-veridian/jobs/ :
/usr/bin/nomad job validate -var "image_tag=staging-<sha7>" deploy/hub-staging.nomad.hcl
/usr/bin/nomad job plan     -var "image_tag=staging-<sha7>" deploy/hub-staging.nomad.hcl   # exit 1 = normal
/usr/bin/nomad job run -detach -var "image_tag=staging-<sha7>" deploy/hub-staging.nomad.hcl

# prod (tag = version vX.Y.Z, sans préfixe) :
/usr/bin/nomad job run -detach -var "image_tag=v0.5.<n>" deploy/hub.nomad.hcl

nomad job status hub          # Latest Deployment = successful
curl -s -o /dev/null -w '%{http_code}\n' https://app.veridian.site/api/health   # 200
```

## Pièges Hub (en plus des 11 du canon Prospection)

- **Pré-pull staging = sur ovh-dev** car le job `hub-staging` est
  `provider=ovh-dev` ; pré-pull prod = **sur ovh-prod**. Il est fait par le script
  serveur (table `app:tier` → nœud), plus par le workflow, mais l'auth GHCR doit
  toujours rester valide sur les deux nœuds cibles : sans elle, Nomad laisse
  l'alloc en `pending` jusqu'au `healthy_deadline`.
- **Migrate-on-boot + Patroni staging** : au démarrage, le container Hub attend
  que le sidecar `pgproxy` route vers un leader. Si l'ordre de démarrage fait
  booter Hub avant pgproxy, le migrate échoue → le `restart` stanza (10×/15s)
  retente jusqu'à ce que pgproxy soit prêt. Self-healing.
