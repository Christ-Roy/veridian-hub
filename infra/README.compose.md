# Hub — stack Dokploy (mode GitOps)

> Migration GitOps : 2026-05-13 (sprint SPRINT-GITOPS-VERIDIAN.md).
> Avant : provider Raw, compose collé dans Dokploy UI.
> Maintenant : provider Git, ce fichier est la source de vérité.

## Identité

| Champ | Valeur |
|---|---|
| Stack Dokploy | `compose-back-up-online-pixel-nl2k9p` |
| Container | `compose-back-up-online-pixel-nl2k9p-hub-prod-1` |
| Image | `ghcr.io/christ-roy/veridian-dashboard` |
| Domaine prod | `app.veridian.site` |
| Healthcheck | `GET /api/health` → `{status: "ok"}` |
| DB | `veridian-core-db:5432/veridian?schema=hub_app` (Postgres dédié) |

## Comment déployer

1. **Bump applicatif** : push sur `main` de ce repo (path `hub/**`)
   → `hub-ci.yml` build et push une nouvelle image `ghcr.io/christ-roy/veridian-dashboard:vX.Y.Z + :latest`
   → le deploy-staging pull `:latest` et redéploie via Dokploy API
2. **Bump compose** (rare) : modifier `infra/services/hub/docker-compose.yml`
   → push sur `main` → webhook Dokploy → redeploy zero-downtime
3. **Rollback** : `git revert -m 1 <merge-sha>` + push → Dokploy redéploie l'état précédent

⚠️ Pas de manipulation Dokploy UI Raw. Tout passe par Git.

## Secrets

Tous les secrets sont configurés dans **Dokploy UI → Stack hub → Environment**.
Le fichier `.env.example` liste les noms attendus.

Ne JAMAIS commit de secret dans ce repo.

## Pinning d'image

Format : `ghcr.io/christ-roy/veridian-dashboard:${HUB_IMAGE_TAG}@sha256:${HUB_IMAGE_DIGEST}`

Le tag par défaut est `latest` (override possible via ENV Dokploy).
Le digest SHA pinne l'image immutable (suis le sprint GitOps : pas de tag flottant pur).

Pour bumper l'image après un nouveau build hub-ci :
```bash
# Récupérer le nouveau digest
ssh prod-pub 'docker inspect ghcr.io/christ-roy/veridian-dashboard:latest --format "{{index .RepoDigests 0}}"'
# Mettre à jour HUB_IMAGE_DIGEST dans Dokploy ENV
```

Dependabot ecosystem `docker` (`/infra/services/hub`) ouvre auto une PR
quand une nouvelle version stable est publiée.

## Blue-green

Le compose supporte le pattern blue-green via `${DEPLOY_ENV}` :
- `DEPLOY_ENV=prod` → router `app.veridian.site`
- `DEPLOY_ENV=green` (sur stack `hub-green` parallèle) → router `hub.green.app.veridian.site`

Cf [06-blue-green-procedure.md](../../../../cc-saas/prompts/applicatif/06-blue-green-procedure.md).

## Forensique pré-migration

Snapshot du compose live + container inspect AVANT bascule :
- `/tmp/forensics-hub-gitops-20260513/compose-live.yml`
- `/tmp/forensics-hub-gitops-20260513/container-inspect.json`

À conserver tant que la stack tourne en mode Git sans incident.
