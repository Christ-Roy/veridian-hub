#!/usr/bin/env bash
# check-no-stripe-live-key.sh
#
# Filet de sécurité critique : aucune clé Stripe LIVE ne doit JAMAIS être
# committée en clair dans le repo. Les clés LIVE (compte prod acct_1SRJN)
# vivent uniquement comme variables d'ENV runtime, injectées par Dokploy
# côté prod — jamais dans un fichier tracké.
#
# Une clé Stripe live secrète a la forme `sk_live_<~99 chars alphanum>`.
# Variantes couvertes :
#   - sk_live_  → secret key live (la plus sensible — accès complet API)
#   - rk_live_  → restricted key live
#   - pk_live_  → publishable key live (moins sensible mais à confiner aussi)
#
# Le check distingue une VRAIE clé d'une simple mention : il exige au moins
# 20 caractères alphanumériques après le préfixe. Ça laisse passer sans
# bruit les faux positifs légitimes :
#   - commentaires       : "# Prod : sk_live_... / Staging : sk_test_..."
#   - préfixes de check  : const expectedPrefix = 'sk_live_'
#   - fausses clés tests : process.env.X = 'sk_live_456'  (3 chars → ignoré)
#
# Câblé dans :
#   - pre-push hook (.husky/pre-push) — empêche un push qui fuiterait une clé
#   - peut être appelé en CI pour un double check
#
# Même esprit que check-no-test-provider-in-prod.sh.
#
# Usage :
#   ./scripts/ci/check-no-stripe-live-key.sh
#
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
NC=$'\033[0m'

# Motif d'une vraie clé Stripe LIVE : préfixe + >=20 chars alphanum.
# Une vraie clé fait ~99 chars ; aucun commentaire ni 'sk_live_456' ne
# franchit le seuil de 20.
LIVE_KEY_PATTERN='(sk|rk|pk)_live_[A-Za-z0-9]{20,}'

# Périmètre : tous les fichiers trackés par Git, sauf ce script lui-même
# (qui contient le motif dans sa doc) et le lockfile pnpm (hashes binaires
# qui peuvent matcher par hasard et ne sont pas du code éditable).
SELF="scripts/ci/check-no-stripe-live-key.sh"

HITS=""
while IFS= read -r file; do
  [ -f "$file" ] || continue
  case "$file" in
    "$SELF"|pnpm-lock.yaml) continue ;;
  esac
  # grep -E sur le fichier ; -I ignore les binaires.
  if MATCH=$(grep -EnI "$LIVE_KEY_PATTERN" "$file" 2>/dev/null); then
    HITS="${HITS}${file}:\n${MATCH}\n"
  fi
done < <(git ls-files)

if [ -n "$HITS" ]; then
  echo "${RED}✗ Clé Stripe LIVE en clair détectée dans un fichier tracké${NC}"
  echo
  printf '%b' "$HITS" | sed 's/^/    /'
  echo
  echo "  Les clés Stripe LIVE ne doivent JAMAIS être committées."
  echo "  Elles vivent uniquement comme ENV runtime (Dokploy prod)."
  echo "  Référencer la variable (\${STRIPE_SECRET_KEY_LIVE}), jamais la valeur."
  echo
  echo "  ${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "  ${RED}║ PUSH REFUSÉ — clé Stripe LIVE en clair dans le repo        ║${NC}"
  echo "  ${RED}╚════════════════════════════════════════════════════════════╝${NC}"
  exit 1
fi

echo "${GREEN}✓ Aucune clé Stripe LIVE en clair — safe${NC}"
exit 0
