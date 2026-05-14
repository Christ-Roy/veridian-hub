#!/usr/bin/env bash
# check-compose-sync.sh
#
# Garde-fou CI pour le pattern docker-compose include.
#
# Vérifie que :
#   1. Tous les fichiers `compose/*.yml` sont des YAML valides
#   2. La combo prod (base + prod) rend un compose valide
#   3. La combo staging (base + staging) rend un compose valide
#   4. `docker-compose.yml` racine contient bien `include:` pointant sur
#      base.yml + prod.yml (interdit de l'éditer à la main avec un service
#      en dur ou un override qui contournerait base.yml)
#   5. Le service `hub` du compose prod consolidé a bien les labels Traefik
#      attendus (host = app.veridian.site, network = dokploy-network)
#
# Exécuté :
#   - Pre-push hook (en plus du mapping route↔test)
#   - CI étage 1 sur toute PR qui touche `compose/**` ou `docker-compose.yml`
#
# Usage : ./scripts/ci/check-compose-sync.sh
# Exit 0 si OK, 1 si dérive détectée.
#
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

FAILED=0
fail() {
  echo "${RED}✗ $1${NC}" >&2
  FAILED=$((FAILED + 1))
}
ok() {
  echo "${GREEN}✓ $1${NC}"
}

# ─── 1. YAML valide ──────────────────────────────────────────────────────
for f in compose/base.yml compose/prod.yml compose/staging.yml; do
  if [ ! -f "$f" ]; then
    fail "$f absent"
    continue
  fi
  if ! python3 -c "import sys, yaml; yaml.safe_load(open('$f'))" 2>/dev/null; then
    fail "$f : YAML invalide"
  else
    ok "$f : YAML valide"
  fi
done

# ─── 2. Combo prod rend un compose valide ────────────────────────────────
# Vars d'env placeholder pour que `config` n'échoue pas sur des vars
# manquantes. Ces valeurs ne sont PAS écrites quelque part — `config` les
# résout en mémoire pour valider la structure.
PROD_VARS="DEPLOY_ENV=prod HUB_HOST=app.veridian.site HUB_IMAGE_TAG=latest \
  HUB_AUTH_SECRET=x GOOGLE_OAUTH_CLIENT_ID=x GOOGLE_OAUTH_CLIENT_SECRET=x \
  VERIDIAN_CORE_DB_PASSWORD=x STRIPE_PUBLISHABLE_KEY_LIVE=x \
  STRIPE_SECRET_KEY_LIVE=x STRIPE_WEBHOOK_SECRET_LIVE=x \
  NOTIFUSE_SECRET_KEY=x NOTIFUSE_ROOT_EMAIL=x NOTIFUSE_HUB_API_SECRET=x \
  NOTIFUSE_HUB_WEBHOOK_SECRET=x TWENTY_APP_SECRET=x \
  PROSPECTION_TENANT_API_SECRET=x BREVO_API_KEY=x CRON_SECRET=x \
  VAULT_ENC_KEY=x GTM_ID_APP_VERIDIAN=x"

if env $PROD_VARS docker compose -f compose/base.yml -f compose/prod.yml config -q 2>/dev/null; then
  ok "compose/base.yml + compose/prod.yml : valide"
else
  fail "compose/base.yml + compose/prod.yml : invalide (config -q a échoué)"
fi

# ─── 3. Combo staging rend un compose valide ─────────────────────────────
STAGING_VARS="BRANCH_SLUG=test-branch HUB_IMAGE_TAG=staging-deadbee \
  HUB_AUTH_SECRET=x POSTGRES_PASSWORD=x"

if env $STAGING_VARS docker compose -f compose/base.yml -f compose/staging.yml config -q 2>/dev/null; then
  ok "compose/base.yml + compose/staging.yml : valide"
else
  fail "compose/base.yml + compose/staging.yml : invalide"
fi

# ─── 4. docker-compose.yml racine est bien un wrapper include ────────────
# On vérifie qu'il a `include:` ET PAS de bloc `services:` en dur (pour
# empêcher quelqu'un d'ajouter un service "vite fait" en court-circuitant
# base.yml).
if ! grep -q '^include:' docker-compose.yml; then
  fail "docker-compose.yml ne contient pas 'include:' — le wrapper a été cassé"
fi

if grep -qE '^services:' docker-compose.yml; then
  fail "docker-compose.yml contient un bloc 'services:' en dur — interdit, modifier compose/*.yml"
fi

# Le wrapper doit référencer base.yml ET prod.yml (pas staging.yml en prod).
# On ignore les commentaires (lignes commençant par #) — staging.yml peut
# être mentionné dans la doc inline du wrapper.
NON_COMMENT=$(grep -vE '^\s*#' docker-compose.yml || true)
if ! echo "$NON_COMMENT" | grep -q 'compose/base.yml'; then
  fail "docker-compose.yml ne référence pas compose/base.yml dans son include"
fi
if ! echo "$NON_COMMENT" | grep -q 'compose/prod.yml'; then
  fail "docker-compose.yml ne référence pas compose/prod.yml dans son include"
fi
if echo "$NON_COMMENT" | grep -q 'compose/staging.yml'; then
  fail "docker-compose.yml référence compose/staging.yml dans son include — prod doit ignorer staging"
fi

[ $FAILED -eq 0 ] && ok "docker-compose.yml : wrapper include valide, base+prod uniquement"

# ─── 5. Sanity check labels Traefik prod ─────────────────────────────────
TRAEFIK_LABELS=$(env $PROD_VARS docker compose -f compose/base.yml -f compose/prod.yml config 2>/dev/null \
  | grep -E 'traefik\.' || true)

if ! echo "$TRAEFIK_LABELS" | grep -q 'Host(`app.veridian.site`)'; then
  fail "Label Traefik host prod manquant ou cassé (attendu : Host(\`app.veridian.site\`))"
fi
if ! echo "$TRAEFIK_LABELS" | grep -q 'traefik.docker.network: dokploy-network'; then
  fail "Network Traefik prod manquant (attendu : dokploy-network)"
fi

# ─── Conclusion ───────────────────────────────────────────────────────────
echo
if [ $FAILED -gt 0 ]; then
  echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
  echo "${RED}║ COMPOSE SYNC CHECK FAILED — $FAILED erreur(s)              ║${NC}"
  echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
  exit 1
fi

echo "${GREEN}✓ Compose pattern OK (base + prod + staging cohérents)${NC}"
exit 0
