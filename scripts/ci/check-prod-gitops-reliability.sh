#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hcl="$root/deploy/hub.nomad.hcl"
ci="$root/.github/workflows/hub-ci.yml"

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
# init anti-zombies et réservation applicative avec plafond de burst.
require_fixed "$hcl" 'priority    = 80' 'priorité Nomad prod absente'
require_fixed "$hcl" 'attempts = 10' 'restart Nomad prod non borné ou absent'
require_fixed "$hcl" 'name     = "hub-selfheal"' 'service self-heal absent'
require_fixed "$hcl" 'limit           = 4' 'check_restart applicatif absent'
require_fixed "$hcl" 'init  = true' 'init Docker anti-zombies absent'
require_fixed "$hcl" 'memory     = 384' 'réservation mémoire app inattendue'
require_fixed "$hcl" 'memory_max = 7000' 'plafond mémoire app absent'

# Nomad plan retourne 0 sans remplacement, 1 avec remplacement, puis un autre
# code en erreur. Le workflow accepte explicitement 0/1 et bloque tout le reste.
require_fixed "$ci" 'PLAN_STATUS=$?' 'code retour du plan Nomad non capturé'
require_fixed "$ci" '1) echo "plan avec remplacement' 'remplacement Nomad normal non accepté'
require_fixed "$ci" '*) echo "::error::nomad job plan a échoué' 'erreur de plan Nomad non bloquante'
reject_fixed "$ci" 'nomad job plan -var "image_tag=${IMAGE_TAG}" "$REMOTE_HCL" || true' 'erreur de plan Nomad masquée'
require_fixed "$ci" 'RUN_INDEX_ARGS=(-check-index "$MODIFY_INDEX")' 'protection TOCTOU check-index absente'
require_fixed "$ci" '/home/brunon5/all-cron/backups/prod-r2-backup.sh' 'backup R2 pré-déploiement absent'

plan_line=$(grep -nF 'PLAN_OUTPUT=$(/usr/bin/nomad job plan' "$ci" | cut -d: -f1)
backup_line=$(grep -nF '/home/brunon5/all-cron/backups/prod-r2-backup.sh' "$ci" | cut -d: -f1)
run_line=$(grep -nF 'EVAL=$(/usr/bin/nomad job run' "$ci" | cut -d: -f1)
[ "$plan_line" -lt "$backup_line" ] || fail 'backup lancé avant validation du plan'
[ "$backup_line" -lt "$run_line" ] || fail 'backup non bloquant avant nomad job run'

echo 'OK: invariants GitOps Hub prod fail-closed'
