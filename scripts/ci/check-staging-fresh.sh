#!/usr/bin/env bash
# check-staging-fresh.sh
#
# Vérifie qu'un deploy staging vert existe dans les dernières 24h sur un SHA
# inclus dans l'historique HEAD courant.
#
# Utilisé après `check-structural-changes.sh` retourne exit 1 :
#   - Changement structurel détecté
#   - On exige une preuve que ce changement (ou un ancêtre récent) a passé staging
#   - Sinon bloque deploy-prod
#
# Requirements :
#   - gh CLI authentifié
#   - GH_REPO ou cwd dans le repo
#
# Output :
#   - exit 0 = staging récent vert trouvé
#   - exit 1 = pas de staging récent vert → bloquer deploy-prod

set -euo pipefail

REPO="${GH_REPO:-Christ-Roy/veridian-hub}"
STAGING_WORKFLOW="${STAGING_WORKFLOW:-hub-staging.yml}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"

# Liste des SHA inclus dans HEAD (les 50 derniers commits — suffit largement)
HEAD_ANCESTORS=$(git log --format='%H' -n 50 2>/dev/null || true)

if [ -z "$HEAD_ANCESTORS" ]; then
  echo "⚠ Impossible de lister les ancêtres HEAD"
  exit 1
fi

# Récupère les 20 derniers runs staging conclude=success, branche=staging
LAST_STAGING_RUNS=$(gh run list \
  --repo "$REPO" \
  --workflow "$STAGING_WORKFLOW" \
  --branch staging \
  --status success \
  --limit 20 \
  --json databaseId,headSha,createdAt 2>/dev/null || echo '[]')

if [ "$LAST_STAGING_RUNS" = "[]" ] || [ -z "$LAST_STAGING_RUNS" ]; then
  echo "❌ Aucun run staging vert récent trouvé"
  exit 1
fi

# Pour chaque run staging vert : vérifier (a) SHA dans ancestors HEAD (b) age < MAX_AGE_HOURS
NOW_TS=$(date -u +%s)
MAX_AGE_SECONDS=$((MAX_AGE_HOURS * 3600))

# Iter via jq.
#
# BUG FIX 2026-05-18 : on n'utilise PAS un pipe `... | while ...` car ça crée
# un subshell où `exit 0` ne sort que du subshell, pas du script. Le script
# atterrissait toujours sur le `exit 1` final même quand un match était trouvé.
# Solution : process substitution `< <(...)` pour garder le while dans le shell
# parent.
while IFS=$'\t' read -r run_id sha created_at; do
  # Parse ISO timestamp → epoch
  run_ts=$(date -u -d "$created_at" +%s 2>/dev/null || echo 0)
  age=$((NOW_TS - run_ts))

  if [ "$age" -gt "$MAX_AGE_SECONDS" ]; then
    continue
  fi

  # SHA dans les ancêtres HEAD ?
  if echo "$HEAD_ANCESTORS" | grep -q "^${sha}$"; then
    echo "✓ Staging vert récent : run $run_id, SHA $sha, age $((age / 3600))h"
    exit 0
  fi
done < <(echo "$LAST_STAGING_RUNS" | jq -r '.[] | "\(.databaseId)\t\(.headSha)\t\(.createdAt)"')

# Si on arrive ici sans avoir trouvé : pas de match
echo "❌ Pas de run staging vert dans les $MAX_AGE_HOURS dernières heures sur un ancêtre de HEAD"
echo
echo "Pour débloquer deploy-prod :"
echo "  1. git checkout staging"
echo "  2. git merge main (ou cherry-pick le SHA structurel)"
echo "  3. git push origin staging"
echo "  4. Attendre le workflow hub-staging.yml vert"
echo "  5. Relancer ce workflow (Re-run all jobs)"
exit 1
