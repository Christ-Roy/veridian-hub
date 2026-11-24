#!/usr/bin/env bash
# Pousse le contenu de HEAD (main) sur la branche staging sans changer de branche : fusion écrite par merge-tree, staging d'abord.
# Un conflit est REFUSÉ (24/11 : un `| head` masquait le code de merge-tree, des marqueurs de conflit ont été commités) ;
# `--main-gagne` le tranche en faveur de main, pour un commit de main réécrit après un premier passage sur staging.
#   scripts/pousser-staging.sh [--main-gagne] "message"      Sortie : 0 poussé · 1 refusé
set -euo pipefail
cd "$(dirname "$0")/.."
X=(); [ "${1:-}" = "--main-gagne" ] && { X=(-X theirs); shift; }
MSG=${1:?message attendu}
git fetch -q origin '+refs/heads/staging:refs/remotes/origin/staging'
if ! SORTIE=$(git merge-tree --write-tree "${X[@]}" refs/remotes/origin/staging HEAD); then
  echo "✗ conflit, rien n'est poussé :"; printf '%s\n' "$SORTIE" | tail -n +2; exit 1
fi
ARBRE=$(printf '%s\n' "$SORTIE" | head -1)
if git grep -lE '^(<<<<<<<|>>>>>>>) ' "$ARBRE" -- ':!*.md'; then echo "✗ marqueurs de conflit dans l'arbre, rien n'est poussé"; exit 1; fi
M=$(git commit-tree "$ARBRE" -p refs/remotes/origin/staging -p HEAD -m "merge(staging): $MSG")
git push -q origin "${M}:refs/heads/staging"
echo "$M"
