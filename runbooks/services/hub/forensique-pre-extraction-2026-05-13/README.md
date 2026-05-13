# Forensique pré-extraction monorepo — 2026-05-13

Snapshots de la stack hub Dokploy **avant** :

1. Sprint GitOps (compose Git SHA-pinned, Trivy gate)
2. Extraction du monorepo `veridian-platform` vers `veridian-hub`

## Contenu

- `compose-live.yml` : le compose stocké dans Dokploy (mode "Raw") tel
  qu'il tournait en prod jusqu'au 2026-05-13. Image
  `:hub-authjs-staging` (legacy tag, jamais bumpé à `:latest` parce que
  la CI hub-ci du monorepo a fail 5 fois sur le push GHCR avant la PR
  fix retry). Les valeurs des ENV sont des références `${VAR}` (pas de
  secrets en clair).

## Ce qui n'est PAS commité ici

- `container-inspect.json` (`docker inspect` du container) : contient les
  valeurs résolues des ENV runtime (BREVO_API_KEY, STRIPE_SECRET_KEY,
  AUTH_SECRET, etc.). **GitHub Push Protection bloque correctement le
  push de ce fichier.** Gardé en local uniquement à
  `/tmp/forensics-hub-gitops-20260513/container-inspect.json` (à
  régénérer si besoin avec `ssh prod-pub 'docker inspect <container>'`).

## Stack Dokploy à ce moment-là

| Champ | Valeur |
|---|---|
| composeId | `_kxAHDCv1LhvsdwNRX3Vk` |
| appName | `compose-back-up-online-pixel-nl2k9p` |
| projectId | `Frcbe1sqrCiRZItPzZ4yL` (Internal Tools) |
| sourceType | `raw` (compose collé dans UI, pas Git) |
| autoDeploy | `true` (mais sans repo source = inopérant) |

## En cas de rollback urgent

Si veridian-hub doit être désactivé et la prod restaurée à l'état d'avant
extraction :

1. Dokploy UI → Stack hub-prod → Settings → Provider : custom-git → raw
2. Paste le contenu de `compose-live.yml` dans le champ Compose
3. Redeploy
4. Vérifier `curl https://app.veridian.site/api/health` → 200

Réactiver alors les workflows monorepo désactivés par PR #102 (ré-ajouter
les triggers push/pull_request dans hub-ci.yml + schedule cron dans
hub-security-cron.yml + sections npm /hub + docker /hub dans dependabot.yml).
