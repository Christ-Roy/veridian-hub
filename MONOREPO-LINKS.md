# Liens vers le monorepo veridian-platform

> Ce repo a été extrait de `Christ-Roy/veridian-platform` le 2026-05-13.
> L'historique git du hub est préservé (39 commits depuis l'init du monorepo).
> Les autres apps Veridian (cms, analytics, notifuse, prospection,
> sites clients) restent dans le monorepo.

## Quand consulter le monorepo

| Tu cherches… | Va voir là-bas |
|---|---|
| Backlog stratégique cross-apps, ordre des sprints | `veridian-platform/todo/TODO-LIVE.md` |
| Vision globale plateforme, architecture cross-apps | `veridian-platform/CLAUDE.md` |
| Doc d'une autre app (cms, analytics…) | `veridian-platform/todo/apps/<app>/TODO.md` |
| Sprint GitOps (référence transverse) | `~/Bureau/SPRINT-GITOPS-VERIDIAN.md` (local) |
| Standards CI/CD partagés (futur) | `veridian-platform/runbooks/standards/` |
| Pattern blue-green Veridian | mémoire `project_blue_green_pattern` |

Worktree local du monorepo (read-only par convention) :
`~/Bureau/veridian-platform-main/`

## Inter-app communication (rappel)

Hub appelle les autres apps Veridian **toujours via URL publique** :
`https://<app>.app.veridian.site` (pas de nom de container interne).

| App | URL prod | Auth |
|---|---|---|
| Prospection | https://prospection.app.veridian.site | Header `X-Tenant-API-Secret` |
| Notifuse | https://notifuse.app.veridian.site | API key tenant + HMAC Hub |

Si tu touches une route d'une autre app que hub consomme, ouvre une issue
sur le monorepo (`Christ-Roy/veridian-platform`), pas ici.

## Ne pas copier de code entre les deux repos

- Si une feature hub demande un changement dans CMS / Analytics / etc.,
  c'est au team lead de l'app concernée de le faire dans le monorepo
- Si un standard CI doit être partagé (ex : workflow `_audit-cve.yml` qu'on
  a dupliqué ici), maintenir la version monorepo et **importer** depuis
  un fork local de temps en temps. Pas de symlink, pas de submodule.

## Sécurité — secrets cloisonnés

Les secrets GitHub Actions sont **par repo**. veridian-hub a sa propre
copie de `DEPLOY_SSH_KEY` + `DOKPLOY_API_KEY` (poussés le 2026-05-13).
Si la clé SSH OVH est rotée, il faut mettre à jour les 2 repos.
> Note : `DOKPLOY_API_KEY` est OBSOLÈTE depuis le décommissionnement Dokploy (2026-07-10) — le deploy passe par Nomad (SSH-bastion, `nomad-v`).
