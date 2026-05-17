# Dependabot — archivé 2026-05-17

Remplacé par **Renovate** (`.github/renovate.json`).

## Pourquoi

Renovate offre :

- Auto-merge total (patch + minor ≥1.0.0 + CVE) via `platformAutomerge`
- `vulnerabilityAlerts` + `osvVulnerabilityAlerts` (couverture OSV + GitHub Advisory)
- `lockFileMaintenance` automatique
- Support natif `docker-compose.yml` (Dependabot ne scanne que `Dockerfile`)
- Dependency Dashboard (issue auto-générée listant tout l'état)
- Groupes monorepo via `group:monorepos` extends
- Rebase auto si conflit (`rebaseWhen: conflicted`)

## Activation côté GitHub

Installer la GitHub App **Renovate** sur l'org `Christ-Roy` :

- <https://github.com/apps/renovate>

Une fois installée, Renovate détecte `.github/renovate.json` et démarre.

## Rollback (si besoin)

```bash
git mv _archive/dependabot/dependabot.yml.archived-2026-05-17 .github/dependabot.yml
git rm .github/renovate.json
```

## Référence

- Spec : `CI-ARCHITECTURE.md` Constitution §7 + §10
- TODO : `todo/CI-TODO.md` section E
