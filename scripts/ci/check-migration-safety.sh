#!/usr/bin/env bash
# check-migration-safety.sh
#
# Garde-fou CI pour migrations Prisma destructives.
#
# Bloque (exit 1) si une migration de la PR contient :
#   1. `DROP COLUMN`           — perte de données irréversible
#   2. `DROP TABLE`            — perte de données irréversible
#   3. `RENAME COLUMN`         — backward-incompat (ancien code lit/écrit toujours)
#   4. `RENAME TABLE`          — backward-incompat
#   5. `ALTER COLUMN ... NOT NULL`  — fail si rows existantes ont NULL
#   6. `ALTER COLUMN ... TYPE`      — risque de truncation / cast fail
#   7. `CREATE INDEX` sans `CONCURRENTLY`  — lock exclusive sur table (downtime)
#   8. `CREATE UNIQUE INDEX` sans `CONCURRENTLY`
#
# Exception : migration marquée `-- @safe: <raison>` en première ligne du
# bloc concerné est autorisée (acknowledgement explicite + audit trail).
#
# Mode :
#   - Pre-push hook (BASE_REF=origin/<branche cible>)
#   - CI étage 1 (BASE_REF=origin/main, sur PR qui touche prisma/migrations/**)
#   - Manuel (BASE_REF=HEAD, scanne le diff HEAD courant)
#
# Usage : ./scripts/ci/check-migration-safety.sh
# Exit 0 si OK ou pas de migration touchée, 1 si pattern destructif détecté.

set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

BASE_REF="${BASE_REF:-origin/main}"

# Liste des fichiers migration .sql ajoutés ou modifiés dans le diff
mapfile -t CHANGED_MIGRATIONS < <(
  git diff --name-only --diff-filter=AM "$BASE_REF"...HEAD -- 'prisma/migrations/**/migration.sql' 2>/dev/null || true
)

if [ ${#CHANGED_MIGRATIONS[@]} -eq 0 ]; then
  echo "${GREEN}✓ Aucune migration Prisma modifiée — skip migration safety check${RESET}"
  exit 0
fi

echo "${BOLD}Migrations à analyser :${RESET}"
for m in "${CHANGED_MIGRATIONS[@]}"; do
  echo "  - $m"
done
echo

FAIL=0
declare -A FINDINGS

scan_pattern() {
  local pattern="$1"
  local desc="$2"
  local file="$3"
  # Récupère les lignes matchant + leur numéro, en ignorant celles précédées d'un commentaire @safe
  local matches
  matches=$(grep -inE "$pattern" "$file" 2>/dev/null || true)

  if [ -z "$matches" ]; then
    return 0
  fi

  while IFS= read -r line; do
    local lineno content
    lineno=$(echo "$line" | cut -d: -f1)
    content=$(echo "$line" | cut -d: -f2-)

    # Skip si la ligne précédente est un acknowledgement @safe
    if [ "$lineno" -gt 1 ]; then
      prev=$(sed -n "$((lineno - 1))p" "$file" 2>/dev/null || echo "")
      if echo "$prev" | grep -qE '^[[:space:]]*--[[:space:]]*@safe:'; then
        echo "${YELLOW}⚠ $file:$lineno — $desc (acknowledged via @safe)${RESET}"
        continue
      fi
    fi

    FAIL=1
    echo "${RED}✗ $file:$lineno — $desc${RESET}"
    echo "    → $(echo "$content" | sed 's/^[[:space:]]*//')"
  done <<< "$matches"
}

for migration in "${CHANGED_MIGRATIONS[@]}"; do
  if [ ! -f "$migration" ]; then
    continue
  fi
  scan_pattern '\bDROP[[:space:]]+COLUMN\b'                'DROP COLUMN (perte de données irréversible)' "$migration"
  scan_pattern '\bDROP[[:space:]]+TABLE\b'                 'DROP TABLE (perte de données irréversible)' "$migration"
  scan_pattern '\bRENAME[[:space:]]+COLUMN\b'              'RENAME COLUMN (backward-incompat)' "$migration"
  scan_pattern '\bALTER[[:space:]]+TABLE[[:space:]]+.*[[:space:]]RENAME[[:space:]]+TO\b' 'RENAME TABLE (backward-incompat)' "$migration"
  scan_pattern '\bALTER[[:space:]]+COLUMN[[:space:]]+.*[[:space:]]SET[[:space:]]+NOT[[:space:]]+NULL\b' 'ALTER COLUMN SET NOT NULL (fail si rows NULL existantes)' "$migration"
  scan_pattern '\bALTER[[:space:]]+COLUMN[[:space:]]+.*[[:space:]]TYPE\b' 'ALTER COLUMN TYPE (risque truncation/cast)' "$migration"

  # CREATE INDEX sans CONCURRENTLY : exclut explicitement "CREATE INDEX CONCURRENTLY"
  matches=$(grep -inE '\bCREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX\b' "$migration" 2>/dev/null | grep -viE '\bCONCURRENTLY\b' || true)
  if [ -n "$matches" ]; then
    while IFS= read -r line; do
      lineno=$(echo "$line" | cut -d: -f1)
      content=$(echo "$line" | cut -d: -f2-)
      if [ "$lineno" -gt 1 ]; then
        prev=$(sed -n "$((lineno - 1))p" "$migration" 2>/dev/null || echo "")
        if echo "$prev" | grep -qE '^[[:space:]]*--[[:space:]]*@safe:'; then
          echo "${YELLOW}⚠ $migration:$lineno — CREATE INDEX sans CONCURRENTLY (acknowledged via @safe)${RESET}"
          continue
        fi
      fi
      FAIL=1
      echo "${RED}✗ $migration:$lineno — CREATE INDEX sans CONCURRENTLY (lock exclusif = downtime)${RESET}"
      echo "    → $(echo "$content" | sed 's/^[[:space:]]*//')"
    done <<< "$matches"
  fi
done

echo
if [ "$FAIL" -eq 1 ]; then
  echo "${RED}${BOLD}❌ Migration safety check FAILED${RESET}"
  echo
  echo "Pour acknowledge un pattern destructif (avec justification écrite) :"
  echo "  ${BOLD}-- @safe: <raison du choix>${RESET}"
  echo "  <ligne destructive>"
  echo
  echo "Ex :"
  echo "  -- @safe: colonne legacy 'twenty_workspace_id' vide depuis migration 20260512, validé par audit"
  echo "  ALTER TABLE tenants DROP COLUMN twenty_workspace_id;"
  echo
  exit 1
fi

echo "${GREEN}✓ Migration safety check OK${RESET}"
exit 0
