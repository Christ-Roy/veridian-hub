#!/usr/bin/env bash
#
# scripts/e2e/staging-full.sh — Lance la suite E2E headfull sur staging Hub.
#
# Cf. CI-ARCHITECTURE.md §20.8.
#
# Usage :
#   pnpm e2e:staging:full
#   pnpm e2e:staging:full --update-snapshots
#   STAGING_URL=https://hub.staging.veridian.site pnpm e2e:staging:full
#   HEADED=0 pnpm e2e:staging:full  # mode headless (CI ou debug)
#
# Pré-conditions :
#   1. Staging répond sur /api/health (sinon abort)
#   2. Playwright chromium installé (`pnpm exec playwright install chromium`)
#
# Output :
#   - e2e-headfull-staging.json   : rapport JSON Playwright
#   - test-results/*              : screenshots / videos / traces
#   - Stdout : récap structuré pour la reco écrite agent (§20.6)
#
set -euo pipefail

STAGING_URL="${STAGING_URL:-https://hub.staging.veridian.site}"

cd "$(dirname "$0")/../.."  # remonte à la racine du repo Hub

# ─── 0. Auto-source des secrets E2E depuis ~/credentials/.all-creds.env ─────
# Plusieurs specs (09, 14, 16) signent des payloads Stripe avec le webhook
# secret réel injecté côté staging depuis 2026-05-23. Si l'agent / robert
# n'exporte rien manuellement, on les récupère depuis le fichier creds
# central. C'est safe (lecture seule, valeurs TEST uniquement).
CREDS_FILE="$HOME/credentials/.all-creds.env"
if [ -f "$CREDS_FILE" ]; then
  for key in STRIPE_WEBHOOK_SECRET_TEST STRIPE_SECRET_KEY_TEST \
             STRIPE_PUBLISHABLE_KEY_TEST STRIPE_REFILL_PRODUCT_ID_TEST \
             HUB_ADMIN_SECRET NOTIFUSE_WEBHOOK_TOKEN \
             HUB_INVITATION_SECRET_NOTIFUSE HUB_INVITATION_SECRET_PROSPECTION \
             HUB_INVITATION_SECRET_ANALYTICS HUB_INVITATION_SECRET_CMS; do
    # Si déjà exporté par l'env appelant : on respecte (override possible).
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

echo "${BLUE}── E2E headfull staging ──${NC}"
echo "Cible : $STAGING_URL"
echo "Config : playwright.staging-full.config.ts"
echo

# ─── 1. Pré-check : staging répond ───────────────────────────────────────────
echo "${BLUE}[1/3] Pré-check /api/health...${NC}"
if ! curl -sf -o /dev/null -m 10 "${STAGING_URL}/api/health"; then
  echo "${RED}✗ Staging ne répond pas sur /api/health — abort.${NC}"
  echo "  URL testée : ${STAGING_URL}/api/health"
  echo "  Vérifie : 1) que staging est déployé, 2) DNS, 3) Tailscale si privatisé"
  exit 1
fi
echo "${GREEN}✓ Staging répond${NC}"
echo

# ─── 2. Lance Playwright ─────────────────────────────────────────────────────
echo "${BLUE}[2/3] Playwright (headfull, slowMo 150ms)...${NC}"
START_TS=$(date +%s)
EXIT_CODE=0
STAGING_URL="$STAGING_URL" \
  pnpm exec playwright test \
    --config=playwright.staging-full.config.ts \
    "$@" \
  || EXIT_CODE=$?

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

echo
echo "${BLUE}[3/3] Récap E2E (durée: ${DURATION}s)${NC}"

# ─── 3. Formate le récap depuis le JSON ──────────────────────────────────────
if [ -f e2e-headfull-staging.json ]; then
  if [ -x scripts/e2e/format-staging-report.js ]; then
    node scripts/e2e/format-staging-report.js e2e-headfull-staging.json
  else
    # Fallback minimal si formatter pas dispo : compte simplement les pass/fail
    PASS=$(node -e "const r=require('./e2e-headfull-staging.json');let p=0;function walk(s){if(s.specs){s.specs.forEach(sp=>sp.tests.forEach(t=>t.results.forEach(rs=>{if(rs.status==='passed')p++})))};if(s.suites)s.suites.forEach(walk)}r.suites.forEach(walk);console.log(p)" 2>/dev/null || echo 0)
    FAIL=$(node -e "const r=require('./e2e-headfull-staging.json');let f=0;function walk(s){if(s.specs){s.specs.forEach(sp=>sp.tests.forEach(t=>t.results.forEach(rs=>{if(rs.status!=='passed'&&rs.status!=='skipped')f++})))};if(s.suites)s.suites.forEach(walk)}r.suites.forEach(walk);console.log(f)" 2>/dev/null || echo 0)
    echo "  ${GREEN}Pass : ${PASS}${NC}"
    echo "  ${RED}Fail : ${FAIL}${NC}"
  fi
else
  echo "${YELLOW}⚠ e2e-headfull-staging.json absent — Playwright n'a pas pu générer le rapport.${NC}"
fi

echo
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${GREEN}║ E2E headfull staging ✓ — utiliser pour reco §20.6/§20.7   ║${NC}"
  echo "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
else
  echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ E2E headfull staging ✗ — NE PAS proposer la promo prod    ║${NC}"
  echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
fi

exit $EXIT_CODE
