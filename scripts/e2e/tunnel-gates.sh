#!/usr/bin/env bash
#
# scripts/e2e/tunnel-gates.sh — JUGE DE PAIX tunnel : gates G0→G10 de parité
# bridge↔Hub, contre le Hub staging.
#
# Porté de `veridian-tunnel-de-vente/tunnel-e2e/run.mjs` (qui tapait le bridge
# dev-pub + SQLite). Ici on tape le Hub staging (Postgres + cron de scoring
# découplé). Le score attendu est rejoué par le MÊME scoring engine que le Hub
# (`getScoringEngine('tunnel-v2')`) → parité prouvée si score DB == attendu.
#
# Usage :
#   pnpm e2e:tunnel
#   STAGING_URL=https://hub.staging.veridian.site pnpm e2e:tunnel
#   pnpm e2e:tunnel -- --grep G8        # un gate précis
#
# Pré-conditions :
#   1. Staging répond sur /api/health (sinon abort)
#   2. `ssh dev-pub` OK (pour sourcer les secrets + runSqlOnStaging)
#   3. Playwright chromium installé
#
set -euo pipefail

STAGING_URL="${STAGING_URL:-https://hub.staging.veridian.site}"

cd "$(dirname "$0")/../.."  # racine du repo Hub

# ─── 0. Secrets sourcés depuis le CONTAINER staging (source de vérité) ────────
# Identique à staging-full.sh étape 0bis : `.all-creds.env` n'est PAS fiable pour
# ces secrets runtime. On lit les valeurs RÉELLES injectées dans hub-staging.
#   - NOTIFUSE_HUB_WEBHOOK_SECRET : signature legacy HMAC (G2/G5/G9)
#   - NOTIFUSE_WEBHOOK_TOKEN      : Bearer v1.4 (G6 page.hit)
#   - CRON_SECRET                 : Bearer du cron push-prospect-scores (G7)
# Sans eux, G0 (préflight) échoue clairement plutôt que des 401 silencieux.
for key in NOTIFUSE_HUB_WEBHOOK_SECRET NOTIFUSE_WEBHOOK_TOKEN CRON_SECRET; do
  if [ -z "${!key:-}" ]; then
    val=$(ssh -o BatchMode=yes -o ConnectTimeout=10 dev-pub \
      "docker exec hub-staging sh -c 'echo \$${key}'" 2>/dev/null | tr -d '\r\n' || true)
    if [ -n "$val" ]; then
      export "$key=$val"
    fi
  fi
done

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

echo "${BLUE}── Juge de paix tunnel (G0→G10, parité bridge↔Hub) ──${NC}"
echo "Cible : $STAGING_URL"
echo "Config : playwright.tunnel.config.ts"
echo

# ─── 1. Pré-check : staging répond ───────────────────────────────────────────
echo "${BLUE}[1/3] Pré-check /api/health...${NC}"
if ! curl -sf -o /dev/null -m 10 "${STAGING_URL}/api/health"; then
  echo "${RED}✗ Staging ne répond pas sur /api/health — abort.${NC}"
  exit 1
fi
echo "${GREEN}✓ Staging répond${NC}"

# Garde-fou secrets : on prévient si un secret manque (G0 le refusera de toute façon).
for key in NOTIFUSE_HUB_WEBHOOK_SECRET NOTIFUSE_WEBHOOK_TOKEN CRON_SECRET; do
  if [ -z "${!key:-}" ]; then
    echo "${YELLOW}⚠ ${key} non sourcé (ssh dev-pub OK ?) — G0 échouera proprement.${NC}"
  fi
done
echo

# ─── 2. Lance Playwright ─────────────────────────────────────────────────────
echo "${BLUE}[2/3] Playwright (gates sériels G0→G10)...${NC}"
START_TS=$(date +%s)
EXIT_CODE=0
STAGING_URL="$STAGING_URL" \
  pnpm exec playwright test \
    --config=playwright.tunnel.config.ts \
    "$@" \
  || EXIT_CODE=$?

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

echo
echo "${BLUE}[3/3] Verdict (durée: ${DURATION}s)${NC}"
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "${GREEN}🟢 PARITÉ PROUVÉE — gates G0→G10 verts. La chaîne Hub reproduit le bridge.${NC}"
else
  echo "${RED}🔴 PARITÉ NON PROUVÉE — au moins un gate rouge (exit ${EXIT_CODE}). Voir le détail ci-dessus.${NC}"
fi

exit "$EXIT_CODE"
