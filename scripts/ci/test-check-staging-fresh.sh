#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
check="$root/scripts/ci/check-staging-fresh.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ " $* " == *" --branch "* ]]; then' \
  '  echo "le workflow staging ne doit pas filtrer la branche source" >&2' \
  '  exit 97' \
  'fi' \
  'sha=$(git rev-parse HEAD)' \
  'created=$(date -u --iso-8601=seconds)' \
  'case "${GH_FAKE_MODE:-exact}" in' \
  '  exact) ;;' \
  '  old) created=$(date -u -d "48 hours ago" --iso-8601=seconds) ;;' \
  '  unrelated) sha=0000000000000000000000000000000000000000 ;;' \
  '  *) exit 98 ;;' \
  'esac' \
  'jq -cn --arg sha "$sha" --arg created "$created" \' \
  '  '\''[{databaseId:123,headSha:$sha,createdAt:$created}]'\''' \
  > "$tmp/bin/gh"
chmod +x "$tmp/bin/gh"

PATH="$tmp/bin:$PATH" GH_FAKE_MODE=exact "$check" >/dev/null

if PATH="$tmp/bin:$PATH" GH_FAKE_MODE=old "$check" >/dev/null 2>&1; then
  echo 'ERREUR: un run staging trop ancien a été accepté' >&2
  exit 1
fi

if PATH="$tmp/bin:$PATH" GH_FAKE_MODE=unrelated "$check" >/dev/null 2>&1; then
  echo 'ERREUR: un SHA staging hors historique a été accepté' >&2
  exit 1
fi

echo 'OK: gate staging accepte le SHA testé, rejette ancien et hors historique'
