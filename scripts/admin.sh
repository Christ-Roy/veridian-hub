#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Veridian Admin CLI
# ============================================================================
# Usage:
#   ./admin.sh list                      # List all tenants
#   ./admin.sh set-plan <email> <plan>   # Set plan (freemium/pro/enterprise)
#   ./admin.sh impersonate <email>       # Get auto-login URLs for a user
#   ./admin.sh health                    # Check all services health
#
# Requires: ADMIN_SECRET or authenticated session
# ============================================================================

HUB_URL="${HUB_URL:-https://app.veridian.site}"
ADMIN_SECRET="${ADMIN_SECRET:-}"

# Load from credentials if not set
if [ -z "$ADMIN_SECRET" ] && [ -f "$HOME/credentials/.all-creds.env" ]; then
  ADMIN_SECRET=$(grep '^ADMIN_SECRET=' "$HOME/credentials/.all-creds.env" 2>/dev/null | cut -d= -f2 || true)
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

api() {
  local method="$1" endpoint="$2" body="${3:-}"
  local args=(-sf -H "x-admin-secret: $ADMIN_SECRET" -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" -X "$method" "$HUB_URL/api/admin/$endpoint" 2>&1
}

cmd_list() {
  echo -e "${BLUE}Fetching tenants...${NC}"
  local data
  data=$(api GET list-tenants)

  echo "$data" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tenants = data.get('tenants', [])
print(f'\n  {len(tenants)} tenant(s)\n')
print(f'{\"Email\":<35} {\"Plan\":<12} {\"Prosp\":<6} {\"Twenty\":<7} {\"Notif\":<6} {\"Trial ends\":<12}')
print('-' * 85)
for t in tenants:
    s = t['services']
    prosp = '✅' if s['prospection']['provisioned'] else '❌'
    twenty = '✅' if s['twenty']['provisioned'] else '❌'
    notif = '✅' if s['notifuse']['provisioned'] else '❌'
    trial = t.get('trial_ends_at','')[:10] if t.get('trial_ends_at') else '-'
    print(f'{t[\"email\"]:<35} {t[\"plan\"]:<12} {prosp:<6} {twenty:<7} {notif:<6} {trial:<12}')
print()
"
}

cmd_set_plan() {
  local email="$1" plan="$2"
  echo -e "${BLUE}Setting plan for $email → $plan...${NC}"
  local result
  result=$(api POST grant-plan "{\"email\":\"$email\",\"plan\":\"$plan\"}")
  echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    print(f'  ✅ {d[\"email\"]} → {d[\"plan\"]} (tenant: {d[\"tenant_id\"]})')
else:
    print(f'  ❌ {d.get(\"error\", \"Unknown error\")}')
"
}

cmd_impersonate() {
  local email="$1"
  echo -e "${BLUE}Generating login links for $email...${NC}"
  local result
  result=$(api POST impersonate "{\"email\":\"$email\"}")
  echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d:
    print(f'  ❌ {d[\"error\"]}')
    sys.exit(1)
print(f'  User: {d[\"email\"]} ({d[\"user_id\"]})')
links = d.get('links', {})
for name, url in links.items():
    if url:
        print(f'  {name}: {url}')
    else:
        print(f'  {name}: (not configured)')
"
}

cmd_health() {
  echo -e "${BLUE}Checking services...${NC}"
  local endpoints=(
    "Hub|${HUB_URL}"
    "Prospection|https://prospection.app.veridian.site/api/health"
    "API|https://api.app.veridian.site/auth/v1/health"
    "Twenty|https://twenty.app.veridian.site"
    "Notifuse|https://notifuse.app.veridian.site"
  )

  for entry in "${endpoints[@]}"; do
    IFS='|' read -r name url <<< "$entry"
    local code
    code=$(curl -sf -o /dev/null -w "%{http_code}" "$url" 2>&1 || echo "000")
    if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
      echo -e "  ${GREEN}✅${NC} $name ($code)"
    else
      echo -e "  ${RED}❌${NC} $name ($code)"
    fi
  done
}

# Main
case "${1:-help}" in
  list) cmd_list ;;
  set-plan)
    [ -z "${2:-}" ] || [ -z "${3:-}" ] && echo "Usage: $0 set-plan <email> <plan>" && exit 1
    cmd_set_plan "$2" "$3" ;;
  impersonate)
    [ -z "${2:-}" ] && echo "Usage: $0 impersonate <email>" && exit 1
    cmd_impersonate "$2" ;;
  health) cmd_health ;;
  *)
    echo "Veridian Admin CLI"
    echo ""
    echo "Usage:"
    echo "  $0 list                      List all tenants"
    echo "  $0 set-plan <email> <plan>   Set plan (freemium/pro/enterprise)"
    echo "  $0 impersonate <email>       Get auto-login URLs"
    echo "  $0 health                    Check all services"
    ;;
esac
