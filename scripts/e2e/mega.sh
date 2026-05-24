#!/usr/bin/env bash
#
# scripts/e2e/mega.sh — Lance la suite MEGA E2E (24 buckets post-commercialisation).
#
# Cf. todo/2026-05-23-MEGA-E2E-post-commercialisation.md.
#
# Usage :
#   pnpm e2e:mega                       # toute la suite
#   pnpm e2e:mega --grep "Mega A"       # un bucket précis
#   pnpm e2e:mega --grep "_smoke"       # juste le smoke fixtures (Vague 1)
#   HEADED=1 pnpm e2e:mega               # mode visuel (debug)
#   STAGING_URL=https://... pnpm e2e:mega
#
# Pré-conditions :
#   1. Pré-check infra OK (`mega-precheck.sh`) — staging up, Stripe TEST,
#      ssh dev-pub, mock OAuth, DBs reachable
#   2. Playwright chromium installé (`pnpm exec playwright install chromium`)
#   3. Creds Stripe TEST + secrets E2E exportés (auto-sourced ici)
#
# Output :
#   - e2e-mega-staging.json     : rapport JSON parseable
#   - playwright-report-mega/   : rapport HTML
#   - test-results/             : traces, screenshots, videos
#   - Stdout : récap structuré pour reco écrite agent
#
set -euo pipefail

STAGING_URL="${STAGING_URL:-https://hub.staging.veridian.site}"

cd "$(dirname "$0")/../.."  # racine du repo Hub

# ─── 0. Auto-source des secrets E2E depuis ~/credentials/.all-creds.env ────
# Réutilise le même mécanisme que staging-full.sh pour cohérence.
CREDS_FILE="$HOME/credentials/.all-creds.env"
if [ -f "$CREDS_FILE" ]; then
  for key in STRIPE_WEBHOOK_SECRET_TEST STRIPE_SECRET_KEY_TEST \
             STRIPE_PUBLISHABLE_KEY_TEST STRIPE_REFILL_PRODUCT_ID_TEST \
             HUB_ADMIN_SECRET NOTIFUSE_WEBHOOK_TOKEN \
             HUB_INVITATION_SECRET_NOTIFUSE HUB_INVITATION_SECRET_PROSPECTION \
             HUB_INVITATION_SECRET_ANALYTICS HUB_INVITATION_SECRET_CMS \
             NOTIFUSE_HUB_API_SECRET PROSPECTION_HUB_API_SECRET \
             E2E_RATELIMIT_BYPASS_SECRET; do
    if [ -z "${!key:-}" ]; then
      val=$(grep "^${key}=" "$CREDS_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
      if [ -n "$val" ]; then
        export "$key=$val"
      fi
    fi
  done
fi

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

echo "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${BLUE}  MEGA E2E — suite bout-en-bout post-commercialisation${NC}"
echo "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "Cible    : $STAGING_URL"
echo "Config   : playwright.mega.config.ts"
echo "RunStamp : ${MEGA_RUN_STAMP:-auto}"
echo

# ─── 1. Pré-check infra (optionnel : skip si --skip-precheck) ───────────────
SKIP_PRECHECK=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--skip-precheck" ]; then
    SKIP_PRECHECK=1
  else
    ARGS+=("$arg")
  fi
done

if [ "$SKIP_PRECHECK" -eq 0 ]; then
  echo "${BLUE}[1/4] Pré-check infra...${NC}"
  if [ -x scripts/e2e/mega-precheck.sh ]; then
    if ! bash scripts/e2e/mega-precheck.sh; then
      echo "${RED}✗ Pré-check infra failed — abort.${NC}"
      echo "  Force le run avec --skip-precheck si tu sais ce que tu fais."
      exit 1
    fi
  else
    echo "${YELLOW}⚠ scripts/e2e/mega-precheck.sh absent — skip pré-check${NC}"
  fi
  echo
fi

# ─── 2. Lance Playwright MEGA ────────────────────────────────────────────────
echo "${BLUE}[2/4] Playwright MEGA (workers parallèles, isolation tenant)...${NC}"
START_TS=$(date +%s)
EXIT_CODE=0
STAGING_URL="$STAGING_URL" \
  pnpm exec playwright test \
    --config=playwright.mega.config.ts \
    "${ARGS[@]}" \
  || EXIT_CODE=$?

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

echo
echo "${BLUE}[3/4] Récap MEGA (durée: ${DURATION}s)${NC}"

# ─── 3. Formate le récap depuis le JSON ──────────────────────────────────────
if [ -f e2e-mega-staging.json ]; then
  if [ -x scripts/e2e/format-staging-report.js ]; then
    node scripts/e2e/format-staging-report.js e2e-mega-staging.json
  else
    PASS=$(node -e "const r=require('./e2e-mega-staging.json');let p=0;function walk(s){if(s.specs){s.specs.forEach(sp=>sp.tests.forEach(t=>t.results.forEach(rs=>{if(rs.status==='passed')p++})))};if(s.suites)s.suites.forEach(walk)}r.suites.forEach(walk);console.log(p)" 2>/dev/null || echo 0)
    FAIL=$(node -e "const r=require('./e2e-mega-staging.json');let f=0;function walk(s){if(s.specs){s.specs.forEach(sp=>sp.tests.forEach(t=>t.results.forEach(rs=>{if(rs.status!=='passed'&&rs.status!=='skipped')f++})))};if(s.suites)s.suites.forEach(walk)}r.suites.forEach(walk);console.log(f)" 2>/dev/null || echo 0)
    echo "  ${GREEN}Pass : ${PASS}${NC}"
    echo "  ${RED}Fail : ${FAIL}${NC}"
  fi
else
  echo "${YELLOW}⚠ e2e-mega-staging.json absent — Playwright n'a pas pu générer le rapport.${NC}"
fi

# ─── 4. globalTeardown a déjà tourné (cleanup Stripe + DBs) ─────────────────
echo
echo "${BLUE}[4/4] globalTeardown exécuté par Playwright${NC}"
echo "  → Stripe customers test : purgés"
echo "  → DB Hub résidus mega-* : purgés"
echo "  → DB Notifuse/Prospection : purgés"
echo "  → Cf. logs ci-dessus pour les counts détaillés"
echo

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${GREEN}║ MEGA E2E ✓ — promotion prod possible (tier 🔴/💀)         ║${NC}"
  echo "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
else
  echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ MEGA E2E ✗ — NE PAS proposer la promo prod                ║${NC}"
  echo "${RED}║   1) Lire playwright-report-mega/index.html               ║${NC}"
  echo "${RED}║   2) Fix la(les) spec(s) rouge(s) sur staging             ║${NC}"
  echo "${RED}║   3) Relance pnpm e2e:mega                                 ║${NC}"
  echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
fi

exit $EXIT_CODE
