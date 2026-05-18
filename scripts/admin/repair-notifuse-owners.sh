#!/usr/bin/env bash
# Repair des tenants Notifuse cassés (bug 2026-05-17), version bash léger.
#
# Pourquoi pas la version TS ? Parce que la version TS a besoin de Prisma
# qui foire sur tunnel SSH (pg_hba.conf prod refuse l'IP du tunnel). Cette
# version contourne en allant chercher la liste directement via
# `docker exec` sur la DB prod, puis appelle Notifuse API depuis ma machine.
#
# Usage :
#   ./scripts/admin/repair-notifuse-owners.sh           # dry-run
#   ./scripts/admin/repair-notifuse-owners.sh --apply   # exécute
#
# Pré-requis :
#   - SSH prod-pub accessible
#   - NOTIFUSE_HUB_API_SECRET dans ~/credentials/.all-creds.env
#   - jq, openssl, curl

set -euo pipefail

APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

CREDS_FILE="$HOME/credentials/.all-creds.env"
if [ ! -f "$CREDS_FILE" ]; then
  echo "ERR $CREDS_FILE introuvable"
  exit 1
fi

# shellcheck disable=SC2155
export NOTIFUSE_HUB_API_SECRET=$(grep "^NOTIFUSE_HUB_API_SECRET=" "$CREDS_FILE" | cut -d= -f2-)
if [ -z "${NOTIFUSE_HUB_API_SECRET:-}" ]; then
  echo "ERR NOTIFUSE_HUB_API_SECRET manquant dans $CREDS_FILE"
  exit 1
fi

NOTIFUSE_URL="${NOTIFUSE_URL:-https://notifuse.app.veridian.site}"
DB_CONTAINER="${DB_CONTAINER:-compose-parse-multi-byte-feed-ywg73b-veridian-core-db-1}"

echo
echo "======================================================================"
if $APPLY; then
  echo " REPAIR Notifuse owners -- APPLY MODE"
else
  echo " REPAIR Notifuse owners -- DRY-RUN"
fi
echo " Notifuse API : $NOTIFUSE_URL"
echo " DB source    : ssh prod-pub docker exec $DB_CONTAINER"
echo "======================================================================"
echo

sign_hmac() {
  local body="$1"
  local ts="$(date +%s)000"
  local sig
  sig=$(printf "%s.%s" "$ts" "$body" | openssl dgst -sha256 -hmac "$NOTIFUSE_HUB_API_SECRET" -r | awk '{print $1}')
  echo "$ts|$sig"
}

hmac_get() {
  local path="$1"
  local ts_sig; ts_sig=$(sign_hmac "")
  local ts="${ts_sig%|*}"; local sig="${ts_sig#*|}"
  curl -sS -w '\nHTTP_STATUS:%{http_code}' \
    -H "X-Veridian-Timestamp: $ts" \
    -H "X-Veridian-Hub-Signature: $sig" \
    "$NOTIFUSE_URL$path"
}

hmac_post() {
  local path="$1"; local body="$2"
  local ts_sig; ts_sig=$(sign_hmac "$body")
  local ts="${ts_sig%|*}"; local sig="${ts_sig#*|}"
  curl -sS -w '\nHTTP_STATUS:%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -H "X-Veridian-Timestamp: $ts" \
    -H "X-Veridian-Hub-Signature: $sig" \
    -d "$body" \
    "$NOTIFUSE_URL$path"
}

TENANTS=$(ssh prod-pub "docker exec $DB_CONTAINER psql -U veridian -d veridian -At -F '|' -c \"
SELECT id, notifuse_workspace_slug, notifuse_user_email
FROM hub_app.tenants
WHERE notifuse_workspace_slug IS NOT NULL
  AND notifuse_user_email IS NOT NULL
  AND notifuse_user_email NOT LIKE 'e2e-%'
ORDER BY created_at ASC
\"" 2>&1 | grep -v '^$' | grep -v 'ERROR' || echo "")

if [ -z "$TENANTS" ]; then
  echo "ERR aucun tenant recupere depuis prod DB"
  exit 1
fi

TENANT_COUNT=$(echo "$TENANTS" | wc -l)
echo "$TENANT_COUNT tenant(s) a scanner"
echo

HEALTHY=0
WOULD_FIX=0
FIXED=0
STILL_BROKEN=0
ERRORS=0

while IFS='|' read -r tenant_id slug email; do
  [ -z "$slug" ] && continue
  echo "--- $email  ($slug, $tenant_id) ---"

  health_resp=$(hmac_get "/api/tenants/$slug/health")
  health_status=$(echo "$health_resp" | grep -oP 'HTTP_STATUS:\K\d+' | tail -1)
  health_body=$(echo "$health_resp" | sed '/HTTP_STATUS:/d')

  if [ "$health_status" = "200" ]; then
    capable=$(echo "$health_body" | jq -r '.magic_link_capable // false')
    owner_email=$(echo "$health_body" | jq -r '.owner_email // "null"')
    if [ "$capable" = "true" ]; then
      echo "  OK already healthy -- owner=$owner_email"
      HEALTHY=$((HEALTHY + 1))
      echo
      continue
    else
      echo "  BROKEN capable=$capable, owner=$owner_email"
    fi
  elif [ "$health_status" = "404" ]; then
    echo "  BROKEN health=404 (pas de plan row OU workspace pas attache)"
  else
    echo "  ERR health unexpected status=$health_status body=$health_body"
    ERRORS=$((ERRORS + 1))
    echo
    continue
  fi

  if ! $APPLY; then
    echo "  DRY-RUN -- aurait appele attach-owner($email)"
    WOULD_FIX=$((WOULD_FIX + 1))
    echo
    continue
  fi

  body=$(jq -n --arg tid "$slug" --arg em "$email" '{tenant_id: $tid, owner_email: $em, role: "owner"}')
  attach_resp=$(hmac_post "/api/veridian/admin/attach-owner" "$body")
  attach_status=$(echo "$attach_resp" | grep -oP 'HTTP_STATUS:\K\d+' | tail -1)
  attach_body=$(echo "$attach_resp" | sed '/HTTP_STATUS:/d')

  if [ "$attach_status" != "200" ]; then
    echo "  ERR attach-owner status=$attach_status body=$attach_body"
    ERRORS=$((ERRORS + 1))
    echo
    continue
  fi

  transferred=$(echo "$attach_body" | jq -r '.owner_transferred // false')
  attached=$(echo "$attach_body" | jq -r '.attached // false')
  already=$(echo "$attach_body" | jq -r '.already_attached // false')
  echo "  OK attach-owner attached=$attached, already=$already, transferred=$transferred"

  health2_resp=$(hmac_get "/api/tenants/$slug/health")
  health2_status=$(echo "$health2_resp" | grep -oP 'HTTP_STATUS:\K\d+' | tail -1)
  health2_body=$(echo "$health2_resp" | sed '/HTTP_STATUS:/d')

  if [ "$health2_status" = "200" ]; then
    capable2=$(echo "$health2_body" | jq -r '.magic_link_capable // false')
    owner2=$(echo "$health2_body" | jq -r '.owner_email')
    if [ "$capable2" = "true" ]; then
      echo "  OK health(after) capable=true, owner=$owner2"
      FIXED=$((FIXED + 1))
    else
      echo "  KO health(after) capable=$capable2, owner=$owner2"
      STILL_BROKEN=$((STILL_BROKEN + 1))
    fi
  else
    echo "  KO health(after) status=$health2_status"
    STILL_BROKEN=$((STILL_BROKEN + 1))
  fi
  echo
done <<< "$TENANTS"

echo "======================================================================"
echo " SUMMARY"
echo "======================================================================"
echo "  Scannes          : $TENANT_COUNT"
echo "  Deja sains       : $HEALTHY"
if $APPLY; then
  echo "  Repares          : $FIXED"
  echo "  Toujours casses  : $STILL_BROKEN"
else
  echo "  A reparer        : $WOULD_FIX"
fi
echo "  Erreurs          : $ERRORS"
echo

if ! $APPLY && [ "$WOULD_FIX" -gt 0 ]; then
  echo "Relancer avec --apply pour reparer les $WOULD_FIX tenant(s) casse(s)."
fi

if [ "$ERRORS" -gt 0 ] || [ "$STILL_BROKEN" -gt 0 ]; then
  exit 1
fi
