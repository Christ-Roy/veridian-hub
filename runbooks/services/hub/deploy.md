# Hub — runbook deploy (post-GitOps)

> Créé pendant le sprint SPRINT-GITOPS-VERIDIAN (2026-05-13).
> Décrit comment redéployer le hub maintenant que la stack Dokploy est en mode Git.

## Architecture deploy

```
Push hub/** sur main
   ↓
hub-ci.yml (.github/workflows/)
   ├── test (pnpm test)
   ├── audit (npm audit high/critical bloquant via _audit-cve.yml)
   ├── docker (build + push ghcr.io/christ-roy/veridian-dashboard:vX.Y.Z + :latest)
   ├── trivy (CRIT/HIGH bloquant sur image fraîche via _trivy-image.yml)
   ├── deploy-staging (pull :latest + redeploy Dokploy compose-input-back-end-application-t364gq)
   └── deploy-prod (redeploy Dokploy compose-back-up-online-pixel-nl2k9p via API)

Push infra/services/hub/** sur main
   ↓
Webhook GitHub → Dokploy compose-back-up-online-pixel-nl2k9p
   ↓
docker compose up zero-downtime (healthcheck /api/health gate)
```

## Stack Dokploy hub

| Champ | Valeur |
|---|---|
| Compose ID | `compose-back-up-online-pixel-nl2k9p` |
| Provider | Git |
| Branche | `main` |
| Path | `infra/services/hub/docker-compose.yml` |
| Auto Deploy | ✅ webhook GitHub |
| Container | `compose-back-up-online-pixel-nl2k9p-hub-prod-1` |
| Image | `ghcr.io/christ-roy/veridian-dashboard:latest@sha256:<digest>` |
| Domaine | `app.veridian.site` (Traefik letsencrypt) |
| DB | `veridian-core-db:5432/veridian` schema `hub_app` |
| Healthcheck | `GET /api/health` (40s start, 30s interval, 10s timeout, 3 retries) |

## Cas standard — push de code Hub

```bash
cd ~/Bureau/veridian-platform-hub
git checkout -b fix/hub-<sujet> origin/main
# ... code ...
git push -u origin fix/hub-<sujet>
gh pr create --fill
gh pr merge --auto --squash
```

`hub-ci.yml` build + push image, Trivy bloque si CVE, déploie en prod via Dokploy API.

## Cas — modifier le compose (rare)

```bash
cd ~/Bureau/veridian-platform-hub
git checkout -b chore/hub-compose-<sujet> origin/main
# ... modif infra/services/hub/docker-compose.yml ...
git push -u origin chore/hub-compose-<sujet>
gh pr create --fill
gh pr merge --auto --squash
# Le webhook GitHub déclenche Dokploy → docker compose up zero-downtime
```

## Cas — bump du SHA digest après build CI

Quand `hub-ci.yml` build une nouvelle image `:latest`, le digest change. Pour pin
ce nouveau digest dans le compose Git :

```bash
# 1. Récupérer le digest courant
NEW_DIGEST=$(ssh prod-pub 'docker inspect ghcr.io/christ-roy/veridian-dashboard:latest --format "{{index .RepoDigests 0}}"' | cut -d@ -f2 | cut -d: -f2)
echo "$NEW_DIGEST"

# 2. Soit l'overrider via Dokploy ENV (rapide, sans PR) :
# Dokploy UI → Stack hub → Environment → HUB_IMAGE_DIGEST=<NEW_DIGEST> → Redeploy

# 3. Soit ouvrir une PR pour mettre à jour le default dans le compose :
# Edit infra/services/hub/docker-compose.yml ligne image: → push → merge
```

Note : on **n'est pas obligé** de bumper le digest à chaque build CI — le pin est une
défense en profondeur. Le tag `:latest` reste valable côté Dokploy car le compose
utilise `${HUB_IMAGE_TAG:-latest}`.

## Rollback prod

### Rollback rapide (< 5 min)

```bash
cd ~/Bureau/veridian-platform-hub
git checkout main
git pull origin main
git revert -m 1 <merge-commit-sha>
git push origin main
```

Le webhook GitHub redéploie l'état précédent en zero-downtime.

### Rollback d'urgence (image cassée mais compose OK)

Override le tag image via Dokploy ENV :

```
Dokploy UI → Stack hub → Environment
  HUB_IMAGE_TAG=v0.4.X  (version précédente, cf gh release list)
  → Redeploy
```

## Smoke post-deploy

```bash
# Status
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sI -o /dev/null -w "%{http_code} " https://app.veridian.site/
done
echo

# Health
curl -sf https://app.veridian.site/api/health

# Pricing (cas historique dual-router /pricing 500 — cf project_hub_dual_router_recidive_2026-05-11)
for i in 1 2 3 4 5; do
  curl -sI -o /dev/null -w "%{http_code} " https://app.veridian.site/pricing
done
echo

# Logs container
ssh prod-pub 'docker logs --since 60s compose-back-up-online-pixel-nl2k9p-hub-prod-1 2>&1 | grep -iE "error|fatal|5[0-9]{2}"'
```

## Secrets — où ils sont

**Dokploy UI → Stack hub → Environment.** Liste des noms attendus : `infra/services/hub/.env.example`.

Aucun secret dans le repo Git. Aucun secret dans le `.env.example` (juste les noms).

Pour les ajouter/modifier : Dokploy UI uniquement. Après chaque modif d'ENV → Redeploy
manuel ou push no-op pour déclencher le webhook.

## Monitoring CVE

- `_audit-cve.yml` : npm audit high/critical bloquant à chaque PR
- `_trivy-image.yml` : Trivy CRIT/HIGH bloquant après build docker
- `hub-security-cron.yml` : cron 3h UTC quotidien sur `:latest` deployed

Si un de ces 3 jobs fail :
- npm audit → ouvrir PR de bump dep (Dependabot l'aura déjà fait normalement)
- Trivy → bump l'image de base dans `hub/Dockerfile` (FROM node:X-slim)
- Cron Trivy → CVE upstream sortie après le merge, idem bump image de base

Cf TODO `todo/apps/hub/TODO.md` section P0.8 pour le loop de validation 7j.
