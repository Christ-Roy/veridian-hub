#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_hcl="$root/deploy/hub.nomad.hcl"
db_hcl="$root/deploy/hub-db.nomad.hcl"

fail() {
  printf 'ERREUR split Nomad Hub: %s\n' "$*" >&2
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

[ -f "$app_hcl" ] || fail 'deploy/hub.nomad.hcl absent'
[ -f "$db_hcl" ] || fail 'deploy/hub-db.nomad.hcl absent'

# Le job public Hub doit rester stateless : aucun postgres, aucun volume DB,
# aucune URL DB localhost qui recouple implicitement l'app à une task DB du même groupe.
require_fixed "$app_hcl" 'job "hub"' 'job applicatif hub absent'
require_fixed "$app_hcl" 'group "app"' 'groupe applicatif dédié absent'
require_fixed "$app_hcl" 'task "hub"' 'task app Hub absente'
require_fixed "$app_hcl" 'reschedule {' 'app stateless sans reschedule'
require_fixed "$app_hcl" 'canary            = 1' 'canary applicatif absent'
require_fixed "$app_hcl" 'auto_revert       = true' 'auto-revert applicatif absent'
require_fixed "$app_hcl" 'task "wait-for-db"' 'readiness DB prestart absent'
require_fixed "$app_hcl" '@100.88.202.29:5432/veridian?schema=hub_app&connect_timeout=10' 'DATABASE_URL ne pointe pas vers hub-db privé ovh-prod'
reject_fixed "$app_hcl" 'task "veridian-core-db"' 'PostgreSQL recohabite dans le job app'
reject_fixed "$app_hcl" '/opt/veridian-lab/hub/core-db:/var/lib/postgresql/data' 'volume DB monté par le job app'
reject_fixed "$app_hcl" '@127.0.0.1:5432/veridian' 'DATABASE_URL localhost interdit en prod app'

# Le job DB est stateful : volume local épinglé, Tailscale-only, aucun reschedule.
require_fixed "$db_hcl" 'job "hub-db"' 'job DB hub-db absent'
require_fixed "$db_hcl" 'group "db"' 'groupe DB dédié absent'
require_fixed "$db_hcl" 'value     = "ovh-prod"' 'DB non épinglée à ovh-prod'
require_fixed "$db_hcl" 'host_network = "tailscale"' 'DB non bornée au réseau Tailscale'
require_fixed "$db_hcl" 'static       = 5432' 'port DB statique privé absent'
require_fixed "$db_hcl" 'task "veridian-core-db"' 'task PostgreSQL absente du job DB'
require_fixed "$db_hcl" '/opt/veridian-lab/hub/core-db:/var/lib/postgresql/data' 'volume DB historique absent'
require_fixed "$db_hcl" 'POSTGRES_USER=veridian' 'POSTGRES_USER historique changé'
require_fixed "$db_hcl" 'POSTGRES_DB=veridian' 'POSTGRES_DB historique changé'
require_fixed "$db_hcl" 'POSTGRES_PASSWORD={{ .VERIDIAN_CORE_DB_PASSWORD }}' 'secret DB historique changé'
reject_fixed "$db_hcl" 'reschedule {' 'reschedule interdit sur DB à volume local'
reject_fixed "$db_hcl" 'traefik.enable=true' 'DB ne doit jamais être exposée Traefik'

if grep -Fq 'task "hub"' "$db_hcl"; then
  fail 'la task app Hub ne doit pas être dans le job DB'
fi

echo 'OK: Hub Nomad prod split stateful/stateless'
