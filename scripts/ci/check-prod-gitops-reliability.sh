#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hcl="$root/deploy/hub.nomad.hcl"
ci="$root/.github/workflows/hub-ci.yml"
staging_ci="$root/.github/workflows/hub-staging.yml"
dockerfile="$root/Dockerfile"
trivyignore="$root/.trivyignore.yaml"

fail() {
  printf 'ERREUR GitOps prod: %s\n' "$*" >&2
  exit 1
}

require_fixed() {
  local file="$1" needle="$2" label="$3"
  grep -Fq -- "$needle" "$file" || fail "$label"
}

reject_fixed() {
  local file="$1" needle="$2" label="$3"
  if grep -Fq -- "$needle" "$file"; then
    fail "$label"
  fi
}

# Invariants du job live: priorité, redémarrage borné, self-heal HTTP,
# init anti-zombies, réservations scheduler et fusible mémoire large.
require_fixed "$hcl" 'priority    = 80' 'priorité Nomad prod absente'
require_fixed "$hcl" 'attempts = 10' 'restart Nomad prod non borné ou absent'
require_fixed "$hcl" 'name     = "hub-selfheal"' 'service self-heal absent'
require_fixed "$hcl" 'limit           = 4' 'check_restart applicatif absent'
require_fixed "$hcl" 'init  = true' 'init Docker anti-zombies absent'
require_fixed "$hcl" 'cpu        = 500' 'réservation CPU app inattendue'
require_fixed "$hcl" 'cpu        = 300' 'réservation CPU DB inattendue'
require_fixed "$hcl" 'memory     = 384' 'réservation mémoire app inattendue'
[ "$(grep -Fc 'memory_max = 7000' "$hcl")" -eq 2 ] \
  || fail 'fusibles mémoire app/DB inattendus'

# Déploiement via les VERBES CONTRAINTS du bastion (constat C4 de l'audit
# d'exposition). La clé `hub-ci-deploy@github` porte désormais
# `command="/usr/local/sbin/veridian-ci-deploy hub"` : elle n'ouvre plus de shell
# et ne peut plus lire le jeton management Nomad. Le pré-pull, le `validate`, le
# `plan` et son code retour, le `-check-index` anti-TOCTOU, le suivi du
# DeploymentID et le backup R2 pré-déploiement vivent maintenant dans ce script
# serveur. Les invariants côté dépôt sont donc devenus : on parle au bastion en
# verbes, et on ne redéclare rien de ce que le serveur garantit déjà.
require_fixed "$ci" '"put-job prod" < "$JOB_FILE"' 'dépôt du HCL prod par verbe put-job absent'
require_fixed "$ci" '"deploy prod ${IMAGE_TAG}"' 'déploiement prod par verbe deploy absent'
require_fixed "$ci" '"cleanup prod"' 'nettoyage prod par verbe cleanup absent'
reject_fixed "$ci" 'bash -s' 'shell distant réintroduit dans le deploy prod'
reject_fixed "$ci" 'nomad-bastion.env' 'jeton Nomad relu depuis la CI prod'
reject_fixed "$ci" 'NOMAD_MGMT_TOKEN' 'jeton management Nomad exposé à la CI prod'
reject_fixed "$ci" '/usr/bin/nomad' 'commande Nomad brute pilotée depuis la CI prod'
reject_fixed "$ci" 'prod-r2-backup.sh' 'backup R2 dupliqué côté CI (il est pré-hook serveur)'
require_fixed "$ci" '-o BatchMode=yes' 'BatchMode absent du deploy prod (clés en no-pty)'

# Staging applique le même contrat, sur son propre tier : la clé est la même, donc
# le tier est le seul degré de liberté laissé au client, et il est validé serveur.
require_fixed "$staging_ci" '"put-job staging" < "$JOB_FILE"' 'dépôt du HCL staging par verbe put-job absent'
require_fixed "$staging_ci" '"deploy staging ${IMAGE_TAG}"' 'déploiement staging par verbe deploy absent'
require_fixed "$staging_ci" '"cleanup staging"' 'nettoyage staging par verbe cleanup absent'
reject_fixed "$staging_ci" 'bash -s' 'shell distant réintroduit dans le deploy staging'
reject_fixed "$staging_ci" 'nomad-bastion.env' 'jeton Nomad relu depuis la CI staging'
reject_fixed "$staging_ci" 'NOMAD_MGMT_TOKEN' 'jeton management Nomad exposé à la CI staging'
reject_fixed "$staging_ci" '/usr/bin/nomad' 'commande Nomad brute pilotée depuis la CI staging'
require_fixed "$staging_ci" '-o BatchMode=yes' 'BatchMode absent du deploy staging (clés en no-pty)'

# Actions Node 20 dépréciées : les versions majeures actuelles utilisent le
# runtime supporté par GitHub et évitent des warnings qui masquent les vrais signaux.
for workflow in "$ci" "$staging_ci"; do
  reject_fixed "$workflow" 'docker/setup-buildx-action@v3' 'setup-buildx Node 20 obsolète'
  reject_fixed "$workflow" 'docker/login-action@v3' 'docker login Node 20 obsolète'
  reject_fixed "$workflow" 'nick-fields/retry@v3' 'retry Node 20 obsolète'
done
reject_fixed "$staging_ci" 'tailscale/github-action@v3' 'Tailscale Node 20 obsolète'

# Le runner n'exécute jamais npm/corepack : migrations et serveur partent via
# node directement. On retire donc leurs paquets bundlés de l'image finale et
# on refuse de réintroduire les anciennes exceptions CVE arrivées à expiration.
require_fixed "$dockerfile" '/usr/local/lib/node_modules/npm' 'suppression npm runtime absente'
require_fixed "$dockerfile" '/usr/local/lib/node_modules/corepack' 'suppression corepack runtime absente'
reject_fixed "$trivyignore" 'CVE-2026-33671' 'ancienne exception picomatch encore active'
reject_fixed "$trivyignore" 'CVE-2026-48815' 'ancienne exception sigstore encore active'

# Le HCL doit être déposé AVANT qu'on demande le déploiement : sans dépôt, le
# script serveur refuse (« aucun HCL déposé »), et l'inverse déploierait le HCL
# du run précédent.
putjob_line=$(grep -nF '"put-job prod" < "$JOB_FILE"' "$ci" | cut -d: -f1)
deploy_line=$(grep -nF '"deploy prod ${IMAGE_TAG}"' "$ci" | cut -d: -f1)
[ "$putjob_line" -lt "$deploy_line" ] || fail 'deploy prod demandé avant le dépôt du HCL'

staging_putjob_line=$(grep -nF '"put-job staging" < "$JOB_FILE"' "$staging_ci" | cut -d: -f1)
staging_deploy_line=$(grep -nF '"deploy staging ${IMAGE_TAG}"' "$staging_ci" | cut -d: -f1)
[ "$staging_putjob_line" -lt "$staging_deploy_line" ] || fail 'deploy staging demandé avant le dépôt du HCL'

echo 'OK: invariants GitOps Hub prod fail-closed'
