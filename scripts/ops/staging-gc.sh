#!/usr/bin/env bash
# staging-gc.sh — Garbage collector hebdo staging Hub
#
# À déployer sur dev-pub sous /opt/scripts/staging-gc.sh + systemd timer.
# Supprime les stacks staging Hub orphelines (PR fermée mais teardown CI
# raté pour cause de SSH down / runner indispo / etc.).
#
# Critères de suppression :
#   1. Dossier sous /opt/staging/hub/<slug>/ existe
#   2. La PR correspondante (head_ref matchant le slug) est closed
#   3. ET le dossier date de plus de 24h (marge pour les teardowns lents)
#
# Si gh CLI n'est pas dispo (pas authentifié), fallback : supprime tout ce
# qui date de plus de 7 jours sans questions.
#
set -euo pipefail

STAGING_ROOT=/opt/staging/hub
REPO=Christ-Roy/veridian-hub
MAX_AGE_DAYS=7

if [ ! -d "$STAGING_ROOT" ]; then
  echo "Pas de $STAGING_ROOT, rien à GC"
  exit 0
fi

cd "$STAGING_ROOT"

# Test gh CLI
GH_OK=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GH_OK=1
fi

KILLED=0
KEPT=0

for stack_dir in */; do
  slug="${stack_dir%/}"
  full_path="$STAGING_ROOT/$slug"
  age_days=$(( ($(date +%s) - $(stat -c %Y "$full_path")) / 86400 ))

  should_kill=0
  reason=""

  if [ "$GH_OK" -eq 1 ]; then
    # Cherche une PR open avec head_ref qui slugifié donne ce slug
    # On regarde les PRs ouvertes ; si aucune ne match → la PR est closed
    open_match=$(gh pr list --repo "$REPO" --state open --json headRefName --jq \
      '.[] | .headRefName | gsub("[/_.]"; "-") | ascii_downcase | gsub("[^a-z0-9-]"; "")' \
      2>/dev/null | grep -Fx "$slug" || true)

    if [ -z "$open_match" ] && [ "$age_days" -gt 0 ]; then
      should_kill=1
      reason="PR closed (slug=$slug, age=${age_days}d)"
    fi
  else
    # Fallback : âge seulement
    if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
      should_kill=1
      reason="age=${age_days}d >= ${MAX_AGE_DAYS}d (gh CLI indispo)"
    fi
  fi

  if [ "$should_kill" -eq 1 ]; then
    echo "GC: kill hub-$slug ($reason)"
    if [ -f "$full_path/compose/base.yml" ] && [ -f "$full_path/compose/staging.yml" ]; then
      (cd "$full_path" && \
        docker compose -p "hub-$slug" \
          -f compose/base.yml -f compose/staging.yml \
          down -v --remove-orphans --timeout 30 || true)
    fi
    rm -rf "$full_path"
    docker image prune -f --filter "label=veridian.staging.branch=$slug" >/dev/null 2>&1 || true
    KILLED=$((KILLED + 1))
  else
    echo "GC: keep hub-$slug (age=${age_days}d, PR still open)"
    KEPT=$((KEPT + 1))
  fi
done

echo
echo "Résumé GC : $KILLED stack(s) supprimée(s), $KEPT conservée(s)"

# Nettoyage images dangling globales (toutes apps confondues)
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

# Alerte Telegram si disk dev > 80%
DISK_PCT=$(df -h / | awk 'NR==2 {gsub("%",""); print $5}')
if [ "$DISK_PCT" -gt 80 ]; then
  echo "::warning::Disk dev à ${DISK_PCT}% après GC"
  if [ -x /opt/scripts/notify-telegram.sh ]; then
    /opt/scripts/notify-telegram.sh "⚠ Dev server disk à ${DISK_PCT}% après staging-gc"
  fi
fi
