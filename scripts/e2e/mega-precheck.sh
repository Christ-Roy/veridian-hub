#!/usr/bin/env bash
#
# scripts/e2e/mega-precheck.sh — Vérifie que l'infra est prête pour MEGA E2E.
#
# Évite de lancer 20 minutes de tests pour découvrir au 1er test que SSH
# dev-pub est down ou que Stripe TEST n'a plus de head_office configuré.
#
# Cf. §6.6 du ticket MEGA pour la liste des pré-conditions.
#
# Usage :
#   bash scripts/e2e/mega-precheck.sh
#
# Exit codes :
#   0 = tout OK, on peut lancer la suite
#   1 = au moins 1 check failed, NE PAS lancer
#
set -uo pipefail

STAGING_URL="${STAGING_URL:-https://hub.staging.veridian.site}"
SSH_HOST="${E2E_SSH_HOST:-dev-pub}"

cd "$(dirname "$0")/../.."

# Auto-source des creds si pas déjà fait
CREDS_FILE="$HOME/credentials/.all-creds.env"
if [ -f "$CREDS_FILE" ]; then
  for key in STRIPE_SECRET_KEY_TEST HUB_ADMIN_SECRET E2E_RATELIMIT_BYPASS_SECRET; do
    if [ -z "${!key:-}" ]; then
      val=$(grep "^${key}=" "$CREDS_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
      [ -n "$val" ] && export "$key=$val"
    fi
  done
fi

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

echo "${BLUE}━━━ MEGA pré-check infra ━━━${NC}"

PASS=0
FAIL=0
WARN=0
FAILED_CHECKS=()

check_pass() {
  echo "${GREEN}  ✓ $1${NC}"
  PASS=$((PASS + 1))
}

check_fail() {
  echo "${RED}  ✗ $1${NC}"
  FAIL=$((FAIL + 1))
  FAILED_CHECKS+=("$1")
}

check_warn() {
  echo "${YELLOW}  ⚠ $1${NC}"
  WARN=$((WARN + 1))
}

# ─── 1. Staging /api/health ──────────────────────────────────────────────
echo
echo "${BLUE}[1/7] Staging Hub /api/health${NC}"
if curl -sf -o /dev/null -m 10 "${STAGING_URL}/api/health"; then
  check_pass "$STAGING_URL/api/health répond 200"
else
  check_fail "$STAGING_URL/api/health ne répond pas (staging down ?)"
fi

# ─── 2. Mock OAuth provider listé ────────────────────────────────────────
echo
echo "${BLUE}[2/7] Mock OAuth provider${NC}"
PROVIDERS_JSON=$(curl -sf -m 10 "${STAGING_URL}/api/auth/providers" 2>/dev/null || echo '{}')
if echo "$PROVIDERS_JSON" | grep -q '"mock-oauth"'; then
  check_pass "mock-oauth provider listé (OAUTH_TEST_PROVIDER=true côté compose)"
else
  check_fail "mock-oauth absent — OAUTH_TEST_PROVIDER pas injecté côté compose staging"
fi

# ─── 3. SSH dev-pub reachable ────────────────────────────────────────────
echo
echo "${BLUE}[3/7] SSH ${SSH_HOST}${NC}"
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" 'echo ok' >/dev/null 2>&1; then
  check_pass "ssh $SSH_HOST OK"
else
  check_fail "ssh $SSH_HOST échoue — vérifie clé chargée (ssh-add -l) + alias dans ~/.ssh/config"
fi

# ─── 4. DB Hub staging container ─────────────────────────────────────────
echo
echo "${BLUE}[4/7] DB Hub staging${NC}"
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
    'docker exec hub-staging-db psql -U hub -d hub -tA -c "SELECT 1;"' \
    >/dev/null 2>&1; then
  check_pass "DB Hub staging accessible (hub-staging-db)"
else
  check_fail "DB Hub staging inaccessible — vérifie ssh $SSH_HOST 'docker ps | grep hub-staging-db'"
fi

# ─── 5. DB Notifuse downstream ───────────────────────────────────────────
echo
echo "${BLUE}[5/7] DB Notifuse staging${NC}"
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
    'docker exec notifuse-staging-db psql -U notifuse -d notifuse -tA -c "SELECT 1;"' \
    >/dev/null 2>&1; then
  check_pass "DB Notifuse staging accessible (notifuse-staging-db)"
else
  check_warn "DB Notifuse staging inaccessible — specs G (cross-app sync) skipperont les asserts downstream"
fi

# ─── 6. DB Prospection downstream ────────────────────────────────────────
echo
echo "${BLUE}[6/7] DB Prospection staging${NC}"
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" \
    'docker exec prospection-staging-db psql -U prospection -d prospection -tA -c "SELECT 1;"' \
    >/dev/null 2>&1; then
  check_pass "DB Prospection staging accessible (prospection-staging-db)"
else
  check_warn "DB Prospection staging inaccessible — specs C-02/E (refill leads) skipperont les asserts downstream"
fi

# ─── 7. Stripe TEST key + head_office FR ─────────────────────────────────
echo
echo "${BLUE}[7/7] Stripe TEST + head_office${NC}"
if [ -z "${STRIPE_SECRET_KEY_TEST:-}" ]; then
  check_fail "STRIPE_SECRET_KEY_TEST manquante — source ~/credentials/.all-creds.env"
elif ! echo "${STRIPE_SECRET_KEY_TEST}" | grep -q '^sk_test_'; then
  check_fail "STRIPE_SECRET_KEY_TEST ne commence pas par sk_test_ (anti-LIVE)"
elif echo "${STRIPE_SECRET_KEY_TEST}" | grep -qE '^sk_test_(fake|xxx|dummy)'; then
  check_fail "STRIPE_SECRET_KEY_TEST ressemble à un placeholder (${STRIPE_SECRET_KEY_TEST:0:16}...)"
else
  # Vérifie via curl Stripe API que la clé répond + head_office FR posé
  ACCOUNT_JSON=$(curl -sf -m 10 \
    -u "${STRIPE_SECRET_KEY_TEST}:" \
    "https://api.stripe.com/v1/account" 2>/dev/null || echo '{}')
  if echo "$ACCOUNT_JSON" | grep -q '"head_office"'; then
    if echo "$ACCOUNT_JSON" | grep -q '"country":"FR"'; then
      check_pass "Stripe TEST OK + head_office FR configuré"
    else
      check_warn "Stripe TEST OK mais head_office country != FR — checkout pourrait fail (cf. spec 12bis)"
    fi
  else
    check_warn "Stripe TEST répond mais head_office introuvable dans la response (clé valide ?)"
  fi
fi

# ─── Résultat ────────────────────────────────────────────────────────────
echo
echo "${BLUE}━━━ Résultat ━━━${NC}"
echo "  Pass  : ${GREEN}${PASS}${NC}"
echo "  Warn  : ${YELLOW}${WARN}${NC}"
echo "  Fail  : ${RED}${FAIL}${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "${RED}✗ Pré-check failed — NE PAS lancer pnpm e2e:mega${NC}"
  echo "${RED}  Checks failed :${NC}"
  for c in "${FAILED_CHECKS[@]}"; do
    echo "${RED}    - $c${NC}"
  done
  exit 1
fi

echo
if [ "$WARN" -gt 0 ]; then
  echo "${YELLOW}⚠ Pré-check OK avec warnings — la suite peut tourner mais certaines specs skipperont.${NC}"
else
  echo "${GREEN}✓ Pré-check OK — lance pnpm e2e:mega${NC}"
fi
exit 0
