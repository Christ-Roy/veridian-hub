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

# Nomad plan retourne 0 sans remplacement, 1 avec remplacement, puis un autre
# code en erreur. Le workflow accepte explicitement 0/1 et bloque tout le reste.
require_fixed "$ci" 'PLAN_STATUS=$?' 'code retour du plan Nomad non capturé'
require_fixed "$ci" '1) echo "plan avec remplacement' 'remplacement Nomad normal non accepté'
require_fixed "$ci" '*) echo "::error::nomad job plan a échoué' 'erreur de plan Nomad non bloquante'
reject_fixed "$ci" 'nomad job plan -var "image_tag=${IMAGE_TAG}" "$REMOTE_HCL" || true' 'erreur de plan Nomad masquée'
require_fixed "$ci" 'RUN_INDEX_ARGS=(-check-index "$MODIFY_INDEX")' 'protection TOCTOU check-index absente'
require_fixed "$ci" '/home/brunon5/all-cron/backups/prod-r2-backup.sh' 'backup R2 pré-déploiement absent'

# Staging doit appliquer les mêmes garanties plan/run, sans le backup DB :
# l'app redémarre, mais PostgreSQL reste dans le cluster Patroni séparé.
require_fixed "$staging_ci" 'PLAN_STATUS=$?' 'code retour du plan staging non capturé'
require_fixed "$staging_ci" '*) echo "::error::nomad job plan staging a échoué' 'erreur de plan staging non bloquante'
reject_fixed "$staging_ci" 'nomad job plan -var "image_tag=${IMAGE_TAG}" "$REMOTE_HCL" || true' 'erreur de plan staging masquée'
require_fixed "$staging_ci" 'RUN_INDEX_ARGS=(-check-index "$MODIFY_INDEX")' 'protection TOCTOU staging absente'

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

plan_line=$(grep -nF 'PLAN_OUTPUT=$(/usr/bin/nomad job plan' "$ci" | cut -d: -f1)
backup_line=$(grep -nF '/home/brunon5/all-cron/backups/prod-r2-backup.sh' "$ci" | cut -d: -f1)
run_line=$(grep -nF 'EVAL=$(/usr/bin/nomad job run' "$ci" | cut -d: -f1)
[ "$plan_line" -lt "$backup_line" ] || fail 'backup lancé avant validation du plan'
[ "$backup_line" -lt "$run_line" ] || fail 'backup non bloquant avant nomad job run'

staging_plan_line=$(grep -nF 'PLAN_OUTPUT=$(/usr/bin/nomad job plan' "$staging_ci" | cut -d: -f1)
staging_run_line=$(grep -nF 'EVAL=$(/usr/bin/nomad job run' "$staging_ci" | cut -d: -f1)
[ "$staging_plan_line" -lt "$staging_run_line" ] || fail 'run staging placé avant le plan'

echo 'OK: invariants GitOps Hub prod fail-closed'
