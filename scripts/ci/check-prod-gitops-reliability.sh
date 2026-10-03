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

# Déploiement par VERBES CONTRAINTS (constat C4). Plan, check-index, pré-pull,
# sauvegarde R2 prod et suivi du déploiement vivent dans le script serveur
# /usr/local/sbin/veridian-ci-deploy : la CI n'envoie que des verbes.
require_fixed "$ci" 'secrets.NOMAD_DEPLOY_SSH_KEY_V2' 'clé SSH contrainte V2 absente du workflow prod'
require_fixed "$staging_ci" 'secrets.NOMAD_DEPLOY_SSH_KEY_V2' 'clé SSH contrainte V2 absente du workflow staging'
for pair in "$ci:prod" "$staging_ci:staging"; do
  wf="${pair%%:*}"; tier="${pair##*:}"
  for verb in "put-job $tier" "deploy $tier" "cleanup $tier"; do
    require_fixed "$wf" "\"$verb" "verbe '$verb' absent de $(basename "$wf")"
  done
  # Interdits : tout ce qui rouvrirait un shell ou lirait le jeton Nomad.
  reject_fixed "$wf" 'bash -s' "heredoc 'bash -s' interdit dans $(basename "$wf")"
  reject_fixed "$wf" 'nomad-bastion.env' "lecture de nomad-bastion.env interdite dans $(basename "$wf")"
  reject_fixed "$wf" 'NOMAD_MGMT_TOKEN' "NOMAD_MGMT_TOKEN interdit dans $(basename "$wf")"
  reject_fixed "$wf" '/usr/bin/nomad' "appel nomad brut interdit dans $(basename "$wf")"
  reject_fixed "$wf" 'secrets.NOMAD_DEPLOY_SSH_KEY }}' "ancienne clé NOMAD_DEPLOY_SSH_KEY (shell complet) interdite dans $(basename "$wf")"
  reject_fixed "$wf" 'scp ' "scp interdit dans $(basename "$wf") : put-job lit le HCL sur stdin"
done
# Le HCL déposé est celui du dépôt, sur stdin.
require_fixed "$ci" '< "$JOB_FILE"' 'put-job prod ne lit pas le HCL du dépôt sur stdin'
require_fixed "$staging_ci" '< "$JOB_FILE"' 'put-job staging ne lit pas le HCL du dépôt sur stdin'
require_fixed "$staging_ci" 'smoke staging' 'smoke staging par verbe absent'

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

# Ordre : put-job, puis deploy, puis cleanup (deploy sans HCL déposé est refusé).
ordre() {
  local wf="$1" tier="$2" put dep cln
  put=$(grep -nF "\"put-job $tier" "$wf" | head -1 | cut -d: -f1)
  dep=$(grep -nF "\"deploy $tier" "$wf" | head -1 | cut -d: -f1)
  cln=$(grep -nF "\"cleanup $tier" "$wf" | head -1 | cut -d: -f1)
  [ -n "$put" ] && [ -n "$dep" ] && [ -n "$cln" ] || fail "verbes $tier introuvables pour l'ordre"
  [ "$put" -lt "$dep" ] || fail "deploy $tier placé avant put-job"
  [ "$dep" -lt "$cln" ] || fail "cleanup $tier placé avant deploy"
}
ordre "$ci" prod
ordre "$staging_ci" staging

echo 'OK: invariants GitOps Hub prod fail-closed'
