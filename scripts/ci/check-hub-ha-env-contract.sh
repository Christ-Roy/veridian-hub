#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prod_hcl="$root/deploy/hub.nomad.hcl"
staging_hcl="$root/deploy/hub-staging.nomad.hcl"

fail() {
  printf 'ERREUR contrat env HA Hub: %s\n' "$*" >&2
  exit 1
}

require_fixed() {
  local file="$1" needle="$2" label="$3"
  grep -Fq -- "$needle" "$file" || fail "$label"
}

reject_regex() {
  local file="$1" regex="$2" label="$3"
  if grep -Eq -- "$regex" "$file"; then
    fail "$label"
  fi
}

for hcl in "$prod_hcl" "$staging_hcl"; do
  require_fixed "$hcl" 'host_network = "tailscale"' \
    "$hcl: port HTTP non publié sur le réseau inter-nœuds Tailscale"
  require_fixed "$hcl" 'HUB_DATABASE_MODE={{' \
    "$hcl: HUB_DATABASE_MODE explicite absent"
  require_fixed "$hcl" 'HUB_DATABASE_HOST={{ $dbHost }}' \
    "$hcl: HUB_DATABASE_HOST rendu absent"
  require_fixed "$hcl" 'HUB_DATABASE_PORT={{ $dbPort }}' \
    "$hcl: HUB_DATABASE_PORT rendu absent"
  require_fixed "$hcl" 'HUB_DATABASE_NAME={{ $dbName }}' \
    "$hcl: HUB_DATABASE_NAME rendu absent"
  require_fixed "$hcl" 'HUB_DATABASE_SCHEMA={{ $dbSchema }}' \
    "$hcl: HUB_DATABASE_SCHEMA rendu absent"
  require_fixed "$hcl" 'DATABASE_URL=postgresql://{{ $dbUser }}:' \
    "$hcl: DATABASE_URL n'est pas composée depuis le contrat HUB_DATABASE_*"

  reject_regex "$hcl" '^DATABASE_URL=.*@127[.]0[.]0[.]1:5432' \
    "$hcl: DATABASE_URL recopie un localhost en dur"
  reject_regex "$hcl" '^DATABASE_URL=.*@(veridian-core-db|hub-staging-db):' \
    "$hcl: DATABASE_URL recopie un nom de conteneur/job en dur"
  reject_regex "$hcl" '^DATABASE_URL=.*{{[[:space:]]*\\.DATABASE_URL[[:space:]]*}}' \
    "$hcl: DATABASE_URL redevient une URL opaque stockée en secret"
  reject_regex "$hcl" 'or \\.[A-Z_]+[[:space:]]' \
    "$hcl: une NomadVarItem est passée à or sans .Value"
done

require_fixed "$prod_hcl" '{{ $dbMode := or .HUB_DATABASE_MODE.Value "local-colocated" }}' \
  "prod: HUB_DATABASE_MODE n'est pas converti en chaîne Nomad"
require_fixed "$prod_hcl" '{{ if eq $dbMode "nomad-service" }}' \
  "prod: mode service-discovery futur non rendu"
require_fixed "$prod_hcl" '{{ $dbServiceName := or .HUB_DATABASE_SERVICE_NAME.Value "hub-postgres" }}' \
  "prod: nom de service DB futur non paramétré"
require_fixed "$prod_hcl" '{{ range nomadService $dbServiceName }}' \
  "prod: le futur endpoint DB ne passe pas par le registry Nomad"
require_fixed "$prod_hcl" 'HUB_DATABASE_MODE.Value "local-colocated"' \
  "prod: fallback local-colocated absent"
require_fixed "$prod_hcl" '{{ $dbServiceName := or .HUB_DATABASE_SERVICE_NAME.Value "veridian-core-db" }}' \
  "prod: nom logique DB historique absent"
require_fixed "$staging_hcl" 'HUB_DATABASE_MODE.Value "patroni-haproxy"' \
  "staging: mode Patroni/HAProxy absent"
require_fixed "$staging_hcl" 'HUB_DATABASE_SERVICE_NAME={{ or .HUB_DATABASE_SERVICE_NAME.Value "hub-staging-db" }}' \
  "staging: nom du service DB staging absent"
require_fixed "$staging_hcl" '{{ range nomadService "hub-staging-db" }}' \
  "staging: HAProxy ne résout pas les membres Patroni via Nomad service discovery"
reject_regex "$staging_hcl" 'server[[:space:]]+patroni-[^[:space:]]+[[:space:]]+100[.][0-9]+[.][0-9]+[.][0-9]+:5433' \
  "staging: IP Tailscale hardcodée dans HAProxy"
for old_ip in 100.108.136.89 100.88.202.29 100.92.215.42; do
  reject_regex "$staging_hcl" "$old_ip:5433" \
    "staging: ancienne IP Patroni $old_ip encore codée"
done

echo 'OK: contrat env HA Hub explicite et anti-URL opaque'
