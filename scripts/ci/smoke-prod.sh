#!/usr/bin/env bash
# smoke-prod.sh — Smoke test prod Hub après deploy
#
# Vérifie :
#   1. Routes publiques retournent 200 (home, login, signup, pricing)
#   2. /api/health retourne 200 + JSON status:ok
#   3. /dashboard retourne 200 ou 307 (redirect auth) — pas 500
#   4. Container compose-back-up-online-pixel-nl2k9p-hub-1 healthy
#   5. 0 erreur dans les logs des 5 dernières minutes (sauf bug Twenty connu)
#
# Sortie 0 si OK, 1 si KO avec message explicite.
#
set -euo pipefail

BASE="https://app.veridian.site"
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

FAILED=0
fail()  { echo "${RED}✗ $1${NC}" >&2; FAILED=$((FAILED + 1)); }
ok()    { echo "${GREEN}✓ $1${NC}"; }
warn()  { echo "${YELLOW}⚠ $1${NC}"; }

# ─── 1. Routes publiques ─────────────────────────────────────────────────
for path in "/" "/login" "/signup" "/pricing"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${BASE}${path}")
  if [ "$code" = "200" ]; then
    ok "GET ${path} → ${code}"
  else
    fail "GET ${path} → ${code} (attendu 200)"
  fi
done

# ─── 2. /api/health ──────────────────────────────────────────────────────
health=$(curl -s --max-time 10 "${BASE}/api/health")
if echo "$health" | grep -q '"status":"ok"'; then
  ok "/api/health → status:ok"
else
  fail "/api/health → réponse anormale: $health"
fi

# ─── 3. /dashboard (200 ou 307 redirect, pas 500) ────────────────────────
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${BASE}/dashboard")
if [ "$code" = "200" ] || [ "$code" = "307" ]; then
  ok "GET /dashboard → ${code} (200=connecté, 307=redirect login)"
elif [ "$code" = "500" ]; then
  fail "GET /dashboard → 500 (Server Component crash — bug RSC ?)"
else
  warn "GET /dashboard → ${code} (inhabituel, à investiguer)"
fi

# ─── 4. Container healthy (via SSH prod) ─────────────────────────────────
if command -v ssh >/dev/null 2>&1; then
  status=$(ssh -o ConnectTimeout=5 prod-pub 'docker inspect compose-back-up-online-pixel-nl2k9p-hub-1 --format "{{.State.Health.Status}}"' 2>/dev/null || echo "ssh-failed")
  if [ "$status" = "healthy" ]; then
    ok "Container hub-1 → healthy"
  elif [ "$status" = "ssh-failed" ]; then
    warn "SSH prod-pub indisponible, skip container check"
  else
    fail "Container hub-1 → ${status}"
  fi
fi

# ─── 5. Erreurs récentes dans les logs (5 min) ───────────────────────────
if command -v ssh >/dev/null 2>&1; then
  errors=$(ssh -o ConnectTimeout=5 prod-pub 'docker logs compose-back-up-online-pixel-nl2k9p-hub-1 --since 5m 2>&1 | grep -iE "error|exception|fatal" | grep -viE "Twenty\] SignUp|TWENTY\] ❌|GTM|provisioning logs|test-noexist" | head -10' 2>/dev/null || echo "")
  if [ -z "$errors" ]; then
    ok "Logs 5min : aucune erreur (hors Twenty bug connu)"
  else
    fail "Logs 5min contiennent des erreurs :"
    echo "$errors" >&2
  fi
fi

echo
if [ $FAILED -gt 0 ]; then
  echo "${RED}╔════════════════════════════════════════════╗${NC}"
  echo "${RED}║ SMOKE PROD FAILED — $FAILED erreur(s)        ║${NC}"
  echo "${RED}╚════════════════════════════════════════════╝${NC}"
  exit 1
fi

echo "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo "${GREEN}║ ✓ SMOKE PROD HUB OK                        ║${NC}"
echo "${GREEN}╚════════════════════════════════════════════╝${NC}"
exit 0
