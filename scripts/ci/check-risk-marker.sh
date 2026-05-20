#!/usr/bin/env bash
#
# check-risk-marker.sh — garde-fou pre-push pour CI-ARCHITECTURE §20
#
# Refuse de pousser un commit qui claim `[risk:low]` dans son message mais
# touche un chemin tier 🔴 HAUT ou 💀 CRITIQUE selon la grille §20.3.
#
# Logique :
#   1. Lit le message du dernier commit (HEAD).
#   2. Si pas de marker `[risk:low]` → OK, on laisse passer (la classif est
#       🟡+ et le job notify-promotion-needed alertera Robert).
#   3. Si marker `[risk:low]` présent → vérifier que les fichiers modifiés
#      sont bien tous dans des scopes tier 🟢 BAS.
#   4. Si un seul fichier est tier 🔴+ → refuse le push avec message clair.
#
# Usage :
#   ./scripts/ci/check-risk-marker.sh                       # pre-push hook
#   BASE_REF=origin/staging ./scripts/ci/check-risk-marker.sh   # CI
#
set -euo pipefail

BASE_REF="${BASE_REF:-origin/staging}"
APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

# ─── Lecture du message commit HEAD ───────────────────────────────────────────
LAST_MSG=$(git log -1 --format=%B)

if ! echo "$LAST_MSG" | grep -q '\[risk:low\]'; then
  # Pas de marker = pas de promesse low → rien à vérifier ici. Le tier 🟡+ sera
  # traité via le protocole "reco écrite agent" (§20.5/20.6/20.7).
  echo "${GREEN}✓ Pas de marker [risk:low] — protocole reco écrite agent applicable${NC}"
  exit 0
fi

# ─── Détermine la liste des fichiers modifiés depuis BASE_REF ────────────────
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  echo "${YELLOW}⚠ $BASE_REF inaccessible, fallback sur HEAD~1${NC}"
  BASE_REF="HEAD~1"
fi

CHANGED=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || true)

if [ -z "$CHANGED" ]; then
  echo "${GREEN}✓ Aucun fichier modifié vs $BASE_REF${NC}"
  exit 0
fi

# ─── Patterns tier 🔴 HAUT / 💀 CRITIQUE (cf. §20.3) ─────────────────────────
#
# Tout chemin matché par ce pattern interdit le marker [risk:low].
TIER_HIGH_PATTERN='^(auth\.ts|auth\.config\.ts|middleware\.ts|lib/auth/|lib/stripe/|lib/prisma/|lib/notifuse/|lib/prospection/|app/api/auth/|app/api/billing/|app/api/webhooks/stripe/|app/api/tenants/|prisma/migrations/|prisma/schema\.prisma|compose/prod\.yml|compose/base\.yml|Dockerfile|\.github/workflows/hub-ci\.yml|\.github/workflows/hub-staging\.yml|utils/tenants/provision\.ts|scripts/admin/.*-prod)'

VIOLATIONS=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if echo "$f" | grep -qE "$TIER_HIGH_PATTERN"; then
    VIOLATIONS+=("$f")
  fi
done <<< "$CHANGED"

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ PUSH REFUSÉ — marker [risk:low] incohérent avec le diff   ║${NC}"
  echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
  echo
  echo "Commit message contient ${YELLOW}[risk:low]${NC} mais ${#VIOLATIONS[@]} fichier(s) sont tier 🔴 HAUT ou 💀 CRITIQUE :"
  for v in "${VIOLATIONS[@]}"; do
    echo "  ${RED}✗${NC} $v"
  done
  echo
  echo "Cf. ${YELLOW}CI-ARCHITECTURE.md §20.3${NC} pour la grille de classification."
  echo
  echo "Action attendue : retire le marker [risk:low] du commit message"
  echo "  (git commit --amend) et laisse le protocole reco écrite agent §20.5/20.6"
  echo "  s'occuper de la promotion. Ne tente pas de bypasser via --no-verify."
  exit 1
fi

echo "${GREEN}✓ Marker [risk:low] cohérent — tous les fichiers modifiés sont tier 🟢 BAS${NC}"
exit 0
