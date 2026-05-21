#!/usr/bin/env bash
# check-no-test-provider-in-prod.sh
#
# Filet de sécurité critique : le flag OAUTH_TEST_PROVIDER active le mock
# OAuth provider qui permet de bypasser Google/Microsoft. S'il fuit en prod,
# c'est une auth bypass complète.
#
# Ce check grep les composes prod/base et fail si OAUTH_TEST_PROVIDER y
# apparaît. Seul compose/staging.yml a le droit de l'avoir.
#
# Câblé dans :
#   - pre-push hook (.husky/pre-push) — empêche de push un compose foireux
#   - workflow CI hub-ci.yml (job security-gate) — double check côté CI
#
# Usage :
#   ./scripts/ci/check-no-test-provider-in-prod.sh
#
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

FAIL=0

# ─── 1. compose/prod.yml ne doit JAMAIS contenir le flag ────────────────
if [ -f compose/prod.yml ]; then
  if grep -nE 'OAUTH_TEST_PROVIDER' compose/prod.yml > /dev/null 2>&1; then
    echo "${RED}✗ compose/prod.yml contient OAUTH_TEST_PROVIDER${NC}"
    echo "  Lignes incriminées :"
    grep -nE 'OAUTH_TEST_PROVIDER' compose/prod.yml | sed 's/^/    /'
    echo
    echo "  Ce flag active un mock OAuth provider qui bypasse Google/Microsoft."
    echo "  Si activé en prod = auth bypass critique. Retirer immédiatement."
    FAIL=$((FAIL + 1))
  else
    echo "${GREEN}✓ compose/prod.yml clean (pas de OAUTH_TEST_PROVIDER)${NC}"
  fi
fi

# ─── 2. compose/base.yml ne doit JAMAIS contenir le flag ────────────────
# (sinon il fuit dans tous les overrides, y compris prod)
if [ -f compose/base.yml ]; then
  if grep -nE 'OAUTH_TEST_PROVIDER' compose/base.yml > /dev/null 2>&1; then
    echo "${RED}✗ compose/base.yml contient OAUTH_TEST_PROVIDER${NC}"
    echo "  Lignes incriminées :"
    grep -nE 'OAUTH_TEST_PROVIDER' compose/base.yml | sed 's/^/    /'
    echo
    echo "  base.yml est partagé par TOUS les environnements — y mettre"
    echo "  OAUTH_TEST_PROVIDER l'active partout, y compris prod. Retirer."
    FAIL=$((FAIL + 1))
  else
    echo "${GREEN}✓ compose/base.yml clean (pas de OAUTH_TEST_PROVIDER)${NC}"
  fi
fi

# ─── 3. compose/staging.yml DOIT contenir le flag ───────────────────────
# (sinon les E2E OAuth ne tournent pas — détecte aussi les push qui
#  supprimeraient le flag par erreur)
if [ -f compose/staging.yml ]; then
  if ! grep -nE 'OAUTH_TEST_PROVIDER.*"true"' compose/staging.yml > /dev/null 2>&1; then
    echo "${YELLOW}⚠ compose/staging.yml ne contient PAS OAUTH_TEST_PROVIDER=\"true\"${NC}"
    echo "  Conséquence : les E2E OAuth (e2e/staging-full/04-oauth-flows.spec.ts)"
    echo "  ne fonctionneront pas. Ajouter le flag ou retirer ce check si décidé."
    # Warning seulement — pas de fail (au cas où Robert veuille temporairement
    # désactiver les E2E OAuth sans bricoler ce script).
  else
    echo "${GREEN}✓ compose/staging.yml a OAUTH_TEST_PROVIDER=\"true\"${NC}"
  fi
fi

# ─── 4. Aucun .env.production / .env.live ne doit avoir le flag ──────────
for f in .env.production .env.live .env.prod; do
  if [ -f "$f" ] && grep -nE 'OAUTH_TEST_PROVIDER' "$f" > /dev/null 2>&1; then
    echo "${RED}✗ $f contient OAUTH_TEST_PROVIDER${NC}"
    FAIL=$((FAIL + 1))
  fi
done

echo
if [ "$FAIL" -gt 0 ]; then
  echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ PUSH REFUSÉ — OAUTH_TEST_PROVIDER présent en prod          ║${NC}"
  echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
  exit 1
fi

echo "${GREEN}✓ Pas de OAUTH_TEST_PROVIDER en prod — safe${NC}"
exit 0
