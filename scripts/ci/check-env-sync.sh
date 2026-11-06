#!/usr/bin/env bash
#
# check-env-sync.sh — Sync ENV vars entre code, .env.example et compose
#
# Adapté du script Prospection (commit a564e91) pour le layout Hub :
#   - Code source = root-level Next.js App Router (pas de src/) →
#     scan app/, lib/, utils/, contexts/, hooks/, middleware.ts, auth*.ts
#   - Composes = `compose/*.yml` (base + prod + staging) au lieu de
#     `infra/docker-compose*.yml`
#
# Refuse le push si :
#   1. Une `process.env.X` est utilisée dans le code MAIS absente à la fois
#      de .env.example ET des composes
#      → Risque : nouveau dev déploie sans la var → app crash ou tourne
#        en mode dégradé silencieux.
#
# Warning (non bloquant) :
#   2. Une var déclarée dans .env.example n'est plus utilisée dans le code
#      ni référencée dans compose/*.yml → dette de doc, à clean.
#
# Coût : ~1s (grep statique).
#
# Skip d'urgence : SKIP_ENV_SYNC=1 git push (à éviter).
# Mode soft (warning only) : ENV_SYNC_SOFT=1
#
# Allowlist : certaines vars sont injectées par Next.js / Auth.js / Prisma
# / Stripe SDK sans `process.env.X` explicite dans notre code, ou sont
# consommées uniquement par le compose pour fabriquer une autre variable
# (ex: VERIDIAN_CORE_DB_PASSWORD → DATABASE_URL). Listées dans
# ALLOWLIST_NATIVE.
set -euo pipefail

if [ "${SKIP_ENV_SYNC:-0}" = "1" ]; then
  echo "⚠ check-env-sync.sh skipped via SKIP_ENV_SYNC=1"
  exit 0
fi

APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

# Vars injectées automatiquement par Next/Node sans déclaration explicite,
# ou consommées en interne par une lib (Prisma lit DATABASE_URL, Auth.js
# lit AUTH_URL/AUTH_TRUST_HOST/NEXTAUTH_URL sans qu'on écrive `process.env.X`).
ALLOWLIST_NATIVE="NODE_ENV PORT HOSTNAME PWD HOME PATH USER CI VERCEL \
  DATABASE_URL NEXTAUTH_URL AUTH_URL AUTH_TRUST_HOST AUTH_SECRET \
  NEXT_TELEMETRY_DISABLED ADMIN_EMAILS"

# Vars autorisées à apparaître dans .env.example même si jamais utilisées
# dans le code source — typiquement consommées par config files
# (next.config.js, prisma/), par compose pour fabriquer une autre var,
# ou par les libs en interne.
ALLOWLIST_DECLARED="DATABASE_URL NEXTAUTH_URL AUTH_URL AUTH_TRUST_HOST \
  AUTH_SECRET ADMIN_EMAILS NEXT_TELEMETRY_DISABLED \
  HUB_IMAGE_TAG HUB_HOST DEPLOY_ENV HUB_AUTH_SECRET \
  HUB_DATABASE_MODE HUB_DATABASE_SERVICE_NAME HUB_DATABASE_USER \
  HUB_DATABASE_HOST HUB_DATABASE_PORT HUB_DATABASE_NAME HUB_DATABASE_SCHEMA \
  VERIDIAN_CORE_DB_PASSWORD POSTGRES_PASSWORD VAULT_ENC_KEY \
  GTM_ID_APP_VERIDIAN OAUTH_TEST_PROVIDER \
  STRIPE_PUBLISHABLE_KEY_LIVE STRIPE_SECRET_KEY_LIVE STRIPE_WEBHOOK_SECRET_LIVE \
  STRIPE_PUBLISHABLE_KEY_TEST STRIPE_SECRET_KEY_TEST STRIPE_WEBHOOK_SECRET_TEST \
  NOTIFUSE_API_ENDPOINT \
  PROSPECTION_INTERNAL_URL \
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD"

# ─── Extraction des vars utilisées dans le code ──────────────────────────────
# Hub = Next.js App Router root-level (pas de src/). Scan tout sauf
# node_modules, .next, _archive, e2e (fixtures), test-results.
CODE_PATHS="app lib utils contexts hooks middleware.ts auth.ts auth.config.ts"
USED_VARS=$(grep -rohE 'process\.env\.[A-Z][A-Z0-9_]+' $CODE_PATHS 2>/dev/null \
  | grep -oE '[A-Z][A-Z0-9_]+$' \
  | sort -u)

if [ -z "$USED_VARS" ]; then
  echo "${YELLOW}⚠ Aucune process.env.* trouvée dans le code — check skip${NC}"
  exit 0
fi

# ─── Extraction des vars déclarées dans .env.example ─────────────────────────
DECLARED_EXAMPLE=""
if [ -f .env.example ]; then
  DECLARED_EXAMPLE=$(grep -E '^[A-Z][A-Z0-9_]+=' .env.example 2>/dev/null \
    | grep -oE '^[A-Z][A-Z0-9_]+' \
    | sort -u)
fi

# ─── Extraction des vars déclarées dans les compose files ────────────────────
DECLARED_COMPOSE=""
if [ -d compose ]; then
  DECLARED_COMPOSE=$(
    {
      # ${VAR_NAME} ou ${VAR_NAME:-default}
      grep -hoE '\$\{[A-Z][A-Z0-9_]+' compose/*.yml 2>/dev/null \
        | grep -oE '[A-Z][A-Z0-9_]+$'
      # environment: VAR_NAME: ... (extraction nom avant le `:`)
      # Match les lignes type "  VAR_NAME: value" sous environment:.
      grep -hE '^\s+[A-Z][A-Z0-9_]+:' compose/*.yml 2>/dev/null \
        | sed -E 's/^\s+([A-Z][A-Z0-9_]+):.*/\1/'
    } | sort -u
  )
fi

DECLARED_ALL=$(printf '%s\n%s\n%s\n' "$DECLARED_EXAMPLE" "$DECLARED_COMPOSE" "$ALLOWLIST_NATIVE" \
  | tr ' ' '\n' | grep -v '^$' | sort -u)

# ─── Diff : vars utilisées mais non déclarées ────────────────────────────────
UNDOCUMENTED=$(comm -23 <(echo "$USED_VARS") <(echo "$DECLARED_ALL"))

# ─── Diff : vars déclarées dans .env.example mais plus utilisées ─────────────
UNUSED=""
if [ -n "$DECLARED_EXAMPLE" ]; then
  ALLOWED_FILTER=$(echo "$ALLOWLIST_DECLARED $ALLOWLIST_NATIVE" | tr ' ' '\n' | sort -u)
  # On considère "utilisée" si présente dans le code OU dans le compose
  # (une var compose-only comme HUB_IMAGE_TAG est légitime).
  USED_OR_COMPOSE=$(printf '%s\n%s\n' "$USED_VARS" "$DECLARED_COMPOSE" | sort -u)
  UNUSED=$(comm -23 <(echo "$DECLARED_EXAMPLE") <(echo "$USED_OR_COMPOSE") \
    | comm -23 - <(echo "$ALLOWED_FILTER") \
    | grep -v '^$' || true)
fi

# ─── Verdict ─────────────────────────────────────────────────────────────────
VIOLATIONS=0

if [ -n "$UNDOCUMENTED" ]; then
  COUNT=$(echo "$UNDOCUMENTED" | grep -c . || true)
  echo "${RED}✗ ${COUNT} var(s) ENV utilisées dans le code MAIS absentes de .env.example ET des composes :${NC}"
  echo "$UNDOCUMENTED" | sed 's/^/  - /'
  echo "${YELLOW}  Fix : ajouter à .env.example avec un commentaire [REQUIRED/OPTIONAL/...]${NC}"
  VIOLATIONS=$((VIOLATIONS + COUNT))
fi

if [ -n "$UNUSED" ]; then
  COUNT=$(echo "$UNUSED" | grep -c . || true)
  echo "${YELLOW}⚠ ${COUNT} var(s) ENV documentées dans .env.example mais introuvables dans code/compose :${NC}"
  echo "$UNUSED" | sed 's/^/  - /'
  echo "${YELLOW}  Reco : retirer de .env.example ou whitelister dans ALLOWLIST_DECLARED (NON BLOQUANT)${NC}"
fi

if [ "$VIOLATIONS" -eq 0 ]; then
  echo "${GREEN}✓ ENV sync OK (code ↔ .env.example ↔ compose)${NC}"
  exit 0
fi

if [ "${ENV_SYNC_SOFT:-0}" = "1" ]; then
  echo "${YELLOW}⚠ ${VIOLATIONS} violation(s) — mode soft, push autorisé${NC}"
  exit 0
fi

echo
echo "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
echo "${RED}║ PUSH REFUSÉ — ${VIOLATIONS} var(s) ENV non documentée(s)        ║${NC}"
echo "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
echo "Skip d'urgence : SKIP_ENV_SYNC=1 git push (NE PAS abuser)"
exit 1
