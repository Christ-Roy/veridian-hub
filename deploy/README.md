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
| `deploy/hub.nomad.hcl` | **PROD** — job `hub`, `provider=ovh-prod`, DB `veridian-core-db` postgres:16 co-localisée aujourd'hui, sert `app.veridian.site`. `DATABASE_URL` est composée depuis `HUB_DATABASE_*` + le mot de passe, pour préparer le cutover HA sans réécrire l'app. `variable image_tag` (défaut `latest`). |
| `deploy/hub-staging.nomad.hcl` | **STAGING** — job `hub-staging`, `provider=ovh-dev`, **DB en cluster Patroni HA** (sidecar HAProxy `pgproxy` → leader dynamique), privé `internal-only@nomad`, sert `hub.staging.veridian.site`. `variable image_tag` (défaut `staging-latest`). |
| `.github/workflows/hub-staging.yml` | Pipeline staging (push `staging`) : build+push GHCR → deploy Nomad SSH-bastion → smoke tailnet. |
| `.github/workflows/hub-ci.yml` | Pipeline prod (push `main`) : test → audit → trivy → docker → deploy-prod (Nomad SSH-bastion) → e2e-prod-smoke. |

## Différences Hub vs canon Prospection

1. **PAS de step `prisma migrate deploy` en CI.** Le Hub migre **AU BOOT** du
   container (`Dockerfile` CMD : `prisma migrate deploy && node scripts/init-stripe.mjs
   && node server.js`, CLI Prisma isolé dans `/opt/prisma-cli`, idempotent +
   advisory lock Postgres). Quand Nomad démarre le nouvel alloc, le migrate
   tourne tout seul contre la DB (prod : endpoint `HUB_DATABASE_*`, fallback
   actuel `local-colocated` ; staging : le leader Patroni via le sidecar
   HAProxy) puis lance le serveur.
   → Le pipeline Hub est plus simple que Prospection (pas de container migrate
   éphémère, pas de hop dev-pub pour migrer). Un migrate qui échoue = container
   jamais healthy → `auto_revert` restaure la version saine.

2. **STAGING en Patroni HA** (Prospection staging = postgres mono-instance). La
   DB `hub` vit dans le cluster `hub-staging-db` ; l'app la joint via le sidecar
   HAProxy `pgproxy` (mode `patroni-haproxy` → leader courant). DATABASE_URL
   reste générée par le contrat `HUB_DATABASE_*`.
   Sur failover, HAProxy bascule (shutdown-sessions → le pool Prisma reconnecte).

3. **Contrat DB prêt HA** : ne plus stocker ni recopier une URL Postgres opaque.
   Le HCL rend :
   - `HUB_DATABASE_MODE` : `local-colocated` aujourd'hui en prod,
     `patroni-haproxy` en staging, futur `nomad-service`.
   - `HUB_DATABASE_SERVICE_NAME` : nom logique du service DB. En mode
     `nomad-service`, il est consommé par `nomadService $dbServiceName` pour
     résoudre l'adresse et le port via le registry Nomad.
   - `HUB_DATABASE_HOST`, `PORT`, `USER`, `NAME`, `SCHEMA` : visibles dans
     l'environnement final pour debug, mais host/port sont rendus par Nomad en
     mode service-discovery.
   - `DATABASE_URL` : seulement la chaîne finale attendue par Prisma.

   Le garde-fou `scripts/ci/check-hub-ha-env-contract.sh` bloque toute
   régression vers `DATABASE_URL=...@127.0.0.1:5432`, un hostname de conteneur,
   ou une URL opaque stockée telle quelle dans une Nomad Variable.

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

# prod (tag = version vX.Y.Z, sans préfixe) :
/usr/bin/nomad job run -detach -var "image_tag=v0.5.<n>" deploy/hub.nomad.hcl

nomad job status hub          # Latest Deployment = successful
curl -s -o /dev/null -w '%{http_code}\n' https://app.veridian.site/api/health   # 200
```

## Pièges Hub (en plus des 11 du canon Prospection)

- **Pré-pull staging = sur ovh-dev** (`ssh -n dev-pub docker pull …`) car le job
  `hub-staging` est `provider=ovh-dev`. Pré-pull prod = **sur ovh-prod**
  (`ssh -n prod-pub docker pull …`). L'auth GHCR doit rester valide sur les deux
  nœuds cibles.
- **Migrate-on-boot + Patroni staging** : au démarrage, le container Hub attend
  que le sidecar `pgproxy` route vers un leader. Si l'ordre de démarrage fait
  booter Hub avant pgproxy, le migrate échoue → le `restart` stanza (10×/15s)
  retente jusqu'à ce que pgproxy soit prêt. Self-healing.
- **Cutover prod HA DB** : ne pas merger une bascule de `HUB_DATABASE_MODE`
  tant que le service/proxy cible n'est pas live, vérifié par `nomad service
  info <service>`, et que les secrets DB ont été copiés dans la Nomad Variable
  du workload cible. Le mot de passe reste un secret, l'endpoint reste un
  contrat.
