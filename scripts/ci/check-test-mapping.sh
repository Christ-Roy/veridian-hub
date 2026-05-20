#!/usr/bin/env bash
# check-test-mapping.sh
#
# Standard CI Veridian — règle 1-pour-1 stricte.
# Bloque tout push qui modifie un fichier critique sans test correspondant.
#
# Comportement :
#   1. Liste les fichiers modifiés (vs origin/main par défaut, ou vs BASE_REF)
#   2. Pour chaque fichier dans les scopes critiques :
#      - Cherche le test colocalisé selon convention de chemin
#      - Si absent : cherche dans test-coverage-map.yaml
#      - Si dans tests-pending.txt : laisse passer (dette acceptée)
#   3. Vérifie comptage strict 1-pour-1 :
#      - Nouveaux exports → exige autant de nouveaux test() / it()
#      - Nouveaux HTTP verbs dans route.ts → exige autant de describe()
#   4. Exit 1 sur le moindre manquement, avec message clair
#
# Usage :
#   ./scripts/ci/check-test-mapping.sh                # local pre-push
#   BASE_REF=origin/main ./scripts/ci/check-test-mapping.sh  # CI
#
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"
APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

# ─── Couleurs sortie ─────────────────────────────────────────────────────────
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

# ─── Diff Git ────────────────────────────────────────────────────────────────
# Modes :
#   - Pre-push hook : BASE_REF=origin/<branche>, compare HEAD..origin (commits non pushés)
#   - CI            : BASE_REF=origin/main, compare PR head..base
#   - Manuel        : BASE_REF=HEAD pour inclure working tree
MODE="committed"
if [ "$BASE_REF" = "HEAD" ]; then
  # Inclut les modifs non commitées (test local)
  CHANGED=$(git diff --name-only HEAD; git diff --cached --name-only)
  CHANGED=$(echo "$CHANGED" | sort -u | grep -v '^$' || true)
  MODE="working-tree"
else
  if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    echo "${YELLOW}⚠ $BASE_REF inaccessible, fallback sur HEAD~1${NC}"
    BASE_REF="HEAD~1"
  fi
  CHANGED=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || true)
fi

if [ -z "$CHANGED" ]; then
  echo "${GREEN}✓ Aucun fichier modifié${NC}"
  exit 0
fi

# ─── Allowlist (dette acceptée) ──────────────────────────────────────────────
PENDING_FILE="tests-pending.txt"
COVERAGE_MAP="test-coverage-map.yaml"

# ─── Mode Nuclear (0 dette) ──────────────────────────────────────────────────
# tests-pending.txt est IGNORÉ sur ces scopes. Toute modif → test obligatoire,
# même si le fichier existait sans test depuis le début.
#
# Scopes Nuclear :
#   - app/api/**/route.ts      (business logic critique)
#   - components/** SAUF components/ui/** (shadcn primitives sans logique)
#   - hooks/**
#   - lib/** (sauf lib/types/*)
#
# Scopes encore en allowlist (tests-pending.txt actif) :
#   - components/ui/** (shadcn, peu testable, peu de logique)
is_nuclear_scope() {
  local f="$1"
  local stripped="${f#src/}"
  case "$stripped" in
    components/ui/*|components/ui/**) return 1 ;;  # PAS Nuclear
    app/api/*/route.ts) return 0 ;;
    components/*.tsx|components/**/*.tsx) return 0 ;;
    hooks/*.ts|hooks/*.tsx) return 0 ;;
    lib/types/*|lib/**/types.ts) return 1 ;;       # PAS Nuclear (types only)
    lib/*.ts|lib/**/*.ts) return 0 ;;
    *) return 1 ;;
  esac
}

in_pending() {
  local f="$1"
  # Mode Nuclear : l'allowlist tests-pending.txt est IGNORÉE.
  # Le fichier doit avoir son test, même s'il a toujours été en dette.
  if is_nuclear_scope "$f"; then
    return 1  # Pas en pending = doit avoir un test
  fi
  # Ignore les lignes commentaires/vides quand on cherche dans pending
  [ -f "$PENDING_FILE" ] && grep -v '^[[:space:]]*#' "$PENDING_FILE" | grep -v '^[[:space:]]*$' | grep -Fxq "$f"
}

# ─── Coverage map ────────────────────────────────────────────────────────────
# Lit test-coverage-map.yaml et résout : pour un source donné, retourne les tests
# qui le couvrent (multi-ligne possible). Parse YAML minimaliste, format strict.
find_covering_tests() {
  local src="$1"
  [ ! -f "$COVERAGE_MAP" ] && return 1
  # Extrait les blocs `- sources:` qui contiennent $src, puis liste leurs `covered_by`
  awk -v src="$src" '
    /^- sources:/        { in_sources=1; in_covered=0; matched=0; covers=""; next }
    /^  covered_by:/     { in_sources=0; in_covered=1; next }
    /^  reason:/         { in_covered=0; if (matched && covers) print covers; matched=0; covers=""; next }
    in_sources && /^    - / { gsub(/^    - /,""); if ($0 == src) matched=1 }
    in_covered && /^    - / { gsub(/^    - /,""); covers = covers (covers?"\n":"") $0 }
    END { if (matched && covers) print covers }
  ' "$COVERAGE_MAP"
}

# ─── Mapping canonique ───────────────────────────────────────────────────────
# Supporte les deux conventions Next.js : à la racine OU sous src/
expected_test_for() {
  local f="$1"
  # Strip src/ prefix si présent, pour normaliser
  local stripped="${f#src/}"
  case "$stripped" in
    app/api/*/route.ts)
      local rel="${stripped#app/api/}"
      rel="${rel%/route.ts}"
      echo "__tests__/api/${rel}.test.ts"
      ;;
    components/*.tsx|components/**/*.tsx)
      local rel="${stripped#components/}"
      rel="${rel%.tsx}"
      echo "__tests__/components/${rel}.test.tsx"
      ;;
    hooks/*.ts|hooks/*.tsx)
      local rel="${stripped#hooks/}"
      rel="${rel%.ts}"
      rel="${rel%.tsx}"
      echo "__tests__/hooks/${rel}.test.ts"
      ;;
    lib/*.ts|lib/**/*.ts)
      # Exclure les fichiers types/* (interfaces seules, non testables)
      case "$stripped" in lib/types/*|lib/**/types.ts) return 1 ;; esac
      local rel="${stripped#lib/}"
      rel="${rel%.ts}"
      echo "__tests__/lib/${rel}.test.ts"
      ;;
    *)
      return 1
      ;;
  esac
}

# ─── Comptage 1-pour-1 ───────────────────────────────────────────────────────
# Diff helper qui s'adapte au mode (working tree vs committed)
diff_for() {
  local f="$1"
  if [ "$MODE" = "working-tree" ]; then
    git diff HEAD -- "$f" 2>/dev/null
  else
    git diff "$BASE_REF"...HEAD -- "$f" 2>/dev/null
  fi
}

# Compte les nouveaux exports dans le diff d'un fichier source
count_new_exports() {
  local f="$1"
  diff_for "$f" \
    | grep -E '^\+[^+]' \
    | grep -cE '^\+\s*export\s+(async\s+)?(function|const|class|default|let|var)\s+\w+' || true
}

# Compte les nouveaux HTTP verbs dans route.ts
count_new_http_verbs() {
  local f="$1"
  diff_for "$f" \
    | grep -E '^\+[^+]' \
    | grep -cE '^\+\s*export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b' || true
}

count_new_tests() {
  local f="$1"
  [ ! -f "$f" ] && echo 0 && return
  diff_for "$f" \
    | grep -E '^\+[^+]' \
    | grep -cE "^\+\s*(test|it)\s*\(" || true
}

count_new_describes() {
  local f="$1"
  [ ! -f "$f" ] && echo 0 && return
  diff_for "$f" \
    | grep -E '^\+[^+]' \
    | grep -cE "^\+\s*describe\s*\(" || true
}

# ─── Boucle principale ───────────────────────────────────────────────────────
FAILED=0
WARNINGS=0

for f in $CHANGED; do
  [ ! -f "$f" ] && continue  # Fichier supprimé, on skip

  # Scope critique ?
  if ! expected_test=$(expected_test_for "$f" 2>/dev/null); then
    continue  # Hors scope critique
  fi

  # Dette acceptée ?
  if in_pending "$f"; then
    echo "${YELLOW}⏸  $f en dette (tests-pending.txt) — laissé passer${NC}"
    WARNINGS=$((WARNINGS + 1))
    continue
  fi

  # ─── 1. Existence du test canonique ───
  test_file=""
  if [ -f "$expected_test" ]; then
    test_file="$expected_test"
  else
    # Fallback coverage map
    covering=$(find_covering_tests "$f")
    if [ -n "$covering" ]; then
      # Au moins un des covered_by doit exister et être modifié
      while IFS= read -r cov; do
        [ -z "$cov" ] && continue
        if [ -f "$cov" ] && echo "$CHANGED" | grep -Fxq "$cov"; then
          test_file="$cov"
          break
        fi
      done <<< "$covering"
      if [ -z "$test_file" ]; then
        echo "${RED}✗ $f${NC}"
        echo "  Couvert par coverage map : $(echo "$covering" | tr '\n' ' ')"
        echo "  Mais aucun de ces tests n'est modifié dans la PR."
        FAILED=$((FAILED + 1))
        continue
      fi
    else
      echo "${RED}✗ $f modifié sans test correspondant${NC}"
      echo "  Test attendu (canonique) : ${expected_test}"
      if is_nuclear_scope "$f"; then
        echo "  ${RED}🔥 MODE NUCLEAR — tests-pending.txt n'autorise plus aucune dette sur ce scope.${NC}"
        echo "  Tu DOIS créer le test colocalisé avant de toucher à ce fichier."
        echo "  Scope concerné : routes API, components (sauf ui/), hooks, lib (sauf types/)."
      else
        echo "  OU déclarer dans test-coverage-map.yaml qu'un autre test le couvre."
      fi
      FAILED=$((FAILED + 1))
      continue
    fi
  fi

  # ─── 2. Test modifié dans la même PR ───
  if ! echo "$CHANGED" | grep -Fxq "$test_file"; then
    echo "${RED}✗ $f modifié, mais $test_file non touché${NC}"
    echo "  Tu as changé la source sans rien adapter dans le test."
    FAILED=$((FAILED + 1))
    continue
  fi

  # ─── 3. Comptage 1-pour-1 ───
  new_exports=$(count_new_exports "$f")
  new_tests=$(count_new_tests "$test_file")

  if [ "$new_exports" -gt "$new_tests" ]; then
    echo "${RED}✗ $f : $new_exports nouveaux exports vs $new_tests nouveaux test()${NC}"
    echo "  Règle 1-pour-1 : chaque nouvel export public doit avoir au moins 1 nouveau test()."
    FAILED=$((FAILED + 1))
    continue
  fi

  # ─── 4. Comptage HTTP verbs (spécifique route.ts) ───
  case "$f" in
    app/api/*/route.ts)
      new_verbs=$(count_new_http_verbs "$f")
      new_describes=$(count_new_describes "$test_file")
      if [ "$new_verbs" -gt "$new_describes" ]; then
        echo "${RED}✗ $f : $new_verbs nouveaux HTTP verbs vs $new_describes nouveaux describe()${NC}"
        echo "  Règle : chaque nouveau verb (GET/POST/...) doit avoir son bloc describe('METHOD ...')."
        FAILED=$((FAILED + 1))
        continue
      fi
      ;;
  esac

  echo "${GREEN}✓ $f → $test_file${NC} (exports=$new_exports tests=$new_tests)"
done

# ─── Migrations Prisma ───────────────────────────────────────────────────────
# Une migration Prisma impose un test qui exerce ou valide le nouveau schéma.
# Deux emplacements acceptés (selon le type de migration) :
#   - __tests__/api/...           → migration qui ajoute/modifie une route
#     (le test API instancie le client Prisma sur le nouveau modèle)
#   - __tests__/integration/migration-*.test.ts → migration DB-only
#     (test d'intégrité du SQL + schema Prisma, pattern de
#     `migration-drop-twenty.test.ts` éprouvé en prod)
PRISMA_CHANGES=$(echo "$CHANGED" | grep -E '^prisma/migrations/.*\.sql$' || true)
if [ -n "$PRISMA_CHANGES" ]; then
  echo
  echo "${BLUE}── Migrations Prisma détectées ──${NC}"
  API_TESTS_TOUCHED=$(echo "$CHANGED" | grep -E '^__tests__/api/.*\.test\.ts$' || true)
  INT_MIGRATION_TESTS_TOUCHED=$(echo "$CHANGED" | grep -E '^__tests__/integration/migration-.*\.test\.ts$' || true)
  if [ -z "$API_TESTS_TOUCHED" ] && [ -z "$INT_MIGRATION_TESTS_TOUCHED" ]; then
    echo "${RED}✗ Migration Prisma sans aucun test integration modifié${NC}"
    echo "  Une migration impose un test, au choix :"
    echo "    - __tests__/api/<route>.test.ts (si la migration ajoute/modifie une route API)"
    echo "    - __tests__/integration/migration-<slug>.test.ts (migration DB-only,"
    echo "      pattern : valider le SQL + cohérence schema Prisma — cf."
    echo "      __tests__/integration/migration-drop-twenty.test.ts)"
    FAILED=$((FAILED + 1))
  else
    echo "${GREEN}✓ Migration accompagnée de tests integration${NC}"
  fi
fi

# ─── Conclusion ──────────────────────────────────────────────────────────────
echo
if [ "$FAILED" -gt 0 ]; then
  echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ PUSH REFUSÉ — $FAILED violation(s) de la règle 1-pour-1     ║${NC}"
  echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
  echo "Fix puis re-tente. JAMAIS --no-verify (Constitution CI §3)."
  echo
  echo "${YELLOW}message de robert: NE BACLE PAS LES TESTS, il faut les tester${NC}"
  echo "${YELLOW}et s'assurer qu'ils soient pertinent et ne casse pas la ci pour${NC}"
  echo "${YELLOW}rien et qu'ils durent !${NC}"
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "${YELLOW}⚠ $WARNINGS fichier(s) en dette tests-pending.txt — à résorber.${NC}"
fi

echo "${GREEN}✓ Mapping route↔test OK${NC}"
exit 0
