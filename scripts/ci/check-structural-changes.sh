#!/usr/bin/env bash
# check-structural-changes.sh
#
# Détecte si le diff entre HEAD et `BASE_REF` (défaut: HEAD~1) touche
# des fichiers structurels (Dockerfile, Prisma schema/migrations, compose,
# package.json, pnpm-lock.yaml).
#
# Si oui : exit 1 + message (le caller — typiquement le job `structural-gate`
# de hub-ci.yml — doit alors vérifier qu'un deploy staging vert existe dans
# les dernières 24h avant de laisser passer `deploy-prod`).
#
# Si non : exit 0 (deploy-prod direct, pas de gate).
#
# Usage :
#   - CI étage 1 (BASE_REF=HEAD~1 sur push main, ou origin/main sur PR)
#   - Manuel (BASE_REF=origin/main pour comparer la branche courante)
#
# Output :
#   - Code exit (0 = pas de structurel, 1 = structurel détecté)
#   - stdout : liste des fichiers structurels modifiés
#   - GITHUB_OUTPUT (si défini) : `has-structural=true|false`

set -euo pipefail

BASE_REF="${BASE_REF:-HEAD~1}"

STRUCTURAL_PATTERNS=(
  '^Dockerfile$'
  '^Dockerfile\.[^/]+$'
  '^prisma/schema\.prisma$'
  '^prisma/migrations/'
  '^compose/'
  '^docker-compose\.yml$'
  '^docker-compose\.[^/]+\.yml$'
  '^package\.json$'
  '^pnpm-lock\.yaml$'
)

CHANGED=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || true)

if [ -z "$CHANGED" ]; then
  echo "✓ Pas de changement détecté"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has-structural=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

STRUCTURAL_CHANGED=""
for pattern in "${STRUCTURAL_PATTERNS[@]}"; do
  match=$(echo "$CHANGED" | grep -E "$pattern" || true)
  if [ -n "$match" ]; then
    STRUCTURAL_CHANGED="${STRUCTURAL_CHANGED}${match}\n"
  fi
done

STRUCTURAL_CHANGED=$(printf "%b" "$STRUCTURAL_CHANGED" | sort -u | grep -v '^$' || true)

if [ -z "$STRUCTURAL_CHANGED" ]; then
  echo "✓ Aucun fichier structurel modifié (deploy-prod direct OK)"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "has-structural=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "⚠ Fichiers structurels modifiés :"
echo "$STRUCTURAL_CHANGED" | sed 's/^/  - /'
echo
echo "→ Staging vert dans les dernières 24h requis avant deploy-prod"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "has-structural=true" >> "$GITHUB_OUTPUT"
exit 1
