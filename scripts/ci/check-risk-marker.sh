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
#
# Le marker [risk:low] doit être présent sur la PREMIÈRE LIGNE du message
# (subject line) pour être pris en compte. Une mention dans le corps du
# commit (doc explicative, exemples) n'active pas le gate — sinon impossible
# de documenter le marker lui-même dans un commit message.
SUBJECT_LINE=$(git log -1 --format=%s)

if ! echo "$SUBJECT_LINE" | grep -q '\[risk:low\]'; then
  # Pas de marker dans le subject = pas de promesse low → rien à vérifier ici.
  # Le tier 🟡+ sera traité via le protocole "reco écrite agent" (§20.5/20.6/20.7).
  echo "${GREEN}✓ Pas de marker [risk:low] dans le subject — protocole reco écrite agent applicable${NC}"
  exit 0
fi

# ─── Détermine la liste des fichiers modifiés par LE COMMIT QUI PORTE LE MARKER ─
#
# Le marker `[risk:low]` qualifie LE commit qui le porte, pas tout un pack.
# On regarde donc UNIQUEMENT le diff de HEAD vs HEAD~1 (le commit courant),
# pas du pack staging vs main.
#
# Cas concret : pack de 4 commits, dont le dernier seul est `[risk:low]` sur
# de la doc. Si on regardait BASE_REF...HEAD, on verrait les fichiers tier 🔴
# touchés par les commits précédents — faux positif, le marker du commit
# courant est légitime.
#
# Limite acceptée : si quelqu'un veut taguer `[risk:low]` un commit qui ne
# touche que de la doc MAIS qu'un commit précédent du pack touche tier 🔴+,
# le pack global reste tier 🔴+. Le marker du dernier commit déclenche
# l'auto-promote CI (qui ff-merge tout le pack jusqu'au HEAD) — incohérence
# potentielle. Pour s'en prémunir : voir §20.4 (gate côté workflow CI), qui
# vérifie aussi que le commit déclencheur fait sens vis-à-vis du pack.
CHANGED=$(git diff --name-only HEAD~1..HEAD 2>/dev/null || true)

if [ -z "$CHANGED" ]; then
  echo "${GREEN}✓ Aucun fichier modifié dans le commit HEAD${NC}"
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
