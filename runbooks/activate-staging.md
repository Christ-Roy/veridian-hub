# Staging Hub — Runbook

> Convention officielle Veridian (cf `CLAUDE.md` racine §Staging) :
> 1 stack staging fixe par app sur le dev server. Pour Hub :
> `hub.staging.veridian.site` (cert wildcard ACME DNS-01 auto via Traefik).

## Architecture

- **Repo** : `Christ-Roy/veridian-hub`
- **Branche** : `staging` (parallèle à `main`)
- **Trigger CI** : push sur `staging` → `.github/workflows/hub-staging.yml`
- **Dev server** : `dev-pub` (`37.187.199.185`)
- **Traefik standalone** : `~/traefik-staging/` sur dev (réseau external `staging-edge`)
- **Compose source** : `compose/base.yml` + `compose/staging.yml` (lu localement par CI puis SCP sur dev)
- **Stack dir sur dev** : `/opt/staging/hub/`
- **URL** : `https://hub.staging.veridian.site`

## Pré-requis infra (déjà en place sur dev)

- ✅ Traefik standalone (systemd `traefik-staging.service`)
- ✅ Network external `staging-edge`
- ✅ DNS wildcard `*.staging.veridian.site` → `37.187.199.185`
- ✅ Cert wildcard ACME DNS-01 (Cloudflare token)
- ✅ User `staging-deploy` sur dev (groupe `docker`, owner `/opt/staging/hub/`)
- ✅ Secrets/vars GitHub repo (cf section "Secrets GitHub" plus bas)

## Workflow opérationnel

### Pour valider un fix avant prod

```sh
# 1. Crée ta branche feature
git checkout -b fix/dashboard-rsc-icon-prop main
# ... code, commit, push ...

# 2. Quand prêt à valider sur staging, merge dans staging
git checkout staging
git merge fix/dashboard-rsc-icon-prop
git push origin staging
# → déclenche hub-staging.yml → deploy sur hub.staging.veridian.site

# 3. Valider visuellement sur https://hub.staging.veridian.site
#    (Chrome, login, parcours, smoke des routes critiques)

# 4. Si OK → PR feature → main → prod (workflow hub-ci.yml)
```

### Pour reset la DB staging

La DB tourne dans un volume persistant `hub-staging-pgdata` (sur dev).
Pour reset complet :

```sh
ssh dev-pub
cd /opt/staging/hub
docker compose -p hub-staging -f compose/base.yml -f compose/staging.yml down -v
# Le -v supprime le volume → DB vide au prochain up
docker compose -p hub-staging --env-file .env -f compose/base.yml -f compose/staging.yml up -d
```

### Pour debug un container qui crashe

```sh
ssh dev-pub 'docker logs hub-staging --tail 200'
ssh dev-pub 'docker logs hub-staging-db --tail 50'
ssh dev-pub 'docker inspect hub-staging --format "{{json .State.Health}}"'
```

## Secrets / Variables GitHub repo (déjà configurés)

**Secrets** (Settings → Secrets and variables → Actions) :
- `STAGING_SSH_KEY` — clé privée ed25519 du user `staging-deploy`
- `STAGING_HUB_AUTH_SECRET` — random 32 bytes pour Auth.js
- `STAGING_POSTGRES_PASSWORD` — random pour DB locale

**Variables** :
- `STAGING_HOST` = `37.187.199.185`
- `STAGING_USER` = `staging-deploy`

## Recréer le user staging-deploy (si besoin)

```sh
ssh dev-pub bash <<'EOF'
sudo useradd -m -s /bin/bash -G docker staging-deploy
sudo mkdir -p /home/staging-deploy/.ssh
PUBKEY="ssh-ed25519 AAA... github-actions-staging-veridian-hub"
echo "$PUBKEY" | sudo tee /home/staging-deploy/.ssh/authorized_keys > /dev/null
sudo chmod 700 /home/staging-deploy/.ssh
sudo chmod 600 /home/staging-deploy/.ssh/authorized_keys
sudo chown -R staging-deploy:staging-deploy /home/staging-deploy/.ssh
sudo mkdir -p /opt/staging/hub
sudo chown -R staging-deploy:staging-deploy /opt/staging
EOF
```

## Troubleshooting

### Workflow staging skip avec "Staging credentials missing"

Les vars `STAGING_HOST` / `STAGING_USER` ou le secret `STAGING_SSH_KEY` ne sont pas configurés. Cf section "Secrets GitHub" ci-dessus.

### Container `hub-staging` ne devient pas healthy

```sh
ssh dev-pub 'docker logs hub-staging --tail 100'
```

Causes fréquentes :
- Migration Prisma échoue au boot → vérifier `DATABASE_URL` et que `hub-staging-db` est healthy
- Variable d'env manquante → Compose log warning si var attendue est vide

### Cert SSL invalide sur `https://hub.staging.veridian.site`

```sh
ssh dev-pub 'docker logs traefik --tail 50 | grep -i cert'
ssh dev-pub 'ls -la ~/traefik-staging/acme/'
```

Le cert wildcard est partagé entre toutes les apps staging. Si pas émis, vérifier le token Cloudflare `CF_DNS_TOKEN_TRAEFIK_DEV` dans `~/credentials/.all-creds.env` sur dev.

### "BRANCH_SLUG variable is not set" warnings

Le `.env` n'est pas chargé par Compose. Doit être à côté du `docker-compose.yml`. La CI fait `--env-file .env` explicite. Si tu cd dans `/opt/staging/hub` manuellement, fais aussi `--env-file .env` à toutes les commandes compose.

## GC

Pas de GC nécessaire avec cette convention (1 stack fixe, pas d'orphans). Le script `scripts/ops/staging-gc.sh` initialement conçu pour les stacks éphémères est conservé mais non-déployé.
