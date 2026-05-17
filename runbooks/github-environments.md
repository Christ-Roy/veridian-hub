# GitHub Environments — Hub

> Référence chantier #8 du `todo/CI-TODO.md` (Constitution CI §6).
> Mis en place : 2026-05-17

## Pourquoi

Les Environments GitHub apportent :

1. **Tracking centralisé des deploys** dans Settings → Environments → `<env>`
   (qui a deploy quoi, quand, depuis quel SHA, lien vers le run)
2. **Protection rules** activables sans toucher au code :
   - `wait_timer` : N minutes avant le job (cooldown)
   - `required_reviewers` : approbation manuelle requise
   - `deployment_branch_policy` : restriction aux branches autorisées
3. **Scoping des secrets** par environnement (futur : sortir secrets prod du
   scope repo et les mettre uniquement sur `production`)
4. **Annotations Grafana** futures basées sur les events deployment
   (`gh api /repos/.../deployments`)

## Environments actuels

| Name | URL | Workflow | Protection rules |
|---|---|---|---|
| `staging` | <https://hub.staging.veridian.site> | `hub-staging.yml` job `deploy` | aucune (wait_timer=0) |
| `production` | <https://app.veridian.site> | `hub-ci.yml` job `deploy-prod` | aucune (wait_timer=0) |

## Gestion

### Lister les Environments

```bash
gh api /repos/Christ-Roy/veridian-hub/environments | jq '.environments[] | {name, protection_rules}'
```

### Activer manual approval sur production (option future)

```bash
gh api -X PUT /repos/Christ-Roy/veridian-hub/environments/production \
  -F 'reviewers[][type]=User' \
  -F 'reviewers[][id]=167650197'   # Christ-Roy user ID
```

À activer si on rajoute le path-based staging gate (changement structurel
détecté → exiger approval avant deploy prod).

### Déplacer un secret vers un Environment

Aujourd'hui : `DEPLOY_SSH_KEY` est secret **repo**.

Pour le sortir du scope repo et le mettre uniquement sur `production` :

```bash
# 1. Récupérer la valeur depuis le secret repo (à faire en local, pas dans la CI)
#    → Pas faisable via API (les secrets sont write-only). Il faut la valeur en clair.

# 2. Créer le secret env
gh secret set DEPLOY_SSH_KEY --env production < ~/credentials/hub-deploy-ssh.key

# 3. Supprimer le secret repo
gh secret delete DEPLOY_SSH_KEY
```

À planifier après stabilisation des workflows.

## Lien avec les workflows

Le job `environment:` field rend le job visible dans :
- `Settings → Environments → <env>` (URL, dernier deploy, history)
- `Code → Deployments` (timeline globale)
- API `GET /repos/.../deployments?environment=<env>`

Et débloque l'usage de `secrets.X` scopés env (`env.production.X` au lieu de
`env.repo.X`).

## TODO follow-up

- [ ] **Path-based staging gate** (chantier #7) — exiger staging vert dans
      les 24h avant production deploy si `Dockerfile|prisma/**|package.json`
      modifiés → `wait_timer` + `required_reviewers` sur production
- [ ] **Annotations Grafana** (chantier #26) — `obs annotate deploy` câblé
      via les events deployment
- [ ] Sortir les secrets prod du scope repo (voir section "Déplacer un secret")
