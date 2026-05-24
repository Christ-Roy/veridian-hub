#!/usr/bin/env bash
#
# scripts/e2e/mega-purge.sh — Filet humain : purge tous les reliquats MEGA E2E.
#
# Cf. §3 du ticket MEGA — "cleanup en cas de panique".
#
# À utiliser si :
#   - une CI a crashé en plein middle et a laissé des tenants test
#   - tu as interrompu un pnpm e2e:mega manuellement (Ctrl+C)
#   - le globalTeardown a partiellement failed et tu vois des résidus
#   - tu veux faire le ménage avant un test important
#
# Idempotent : safe à relancer 10× sans rien casser.
#
# Usage :
#   bash scripts/e2e/mega-purge.sh                    # purge complète
#   bash scripts/e2e/mega-purge.sh --dry-run          # liste sans supprimer
#   bash scripts/e2e/mega-purge.sh --stripe-only      # purge Stripe seulement
#   bash scripts/e2e/mega-purge.sh --db-only          # purge DB seulement
#
set -uo pipefail

cd "$(dirname "$0")/../.."

CREDS_FILE="$HOME/credentials/.all-creds.env"
if [ -f "$CREDS_FILE" ]; then
  for key in STRIPE_SECRET_KEY_TEST; do
    if [ -z "${!key:-}" ]; then
      val=$(grep "^${key}=" "$CREDS_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
      [ -n "$val" ] && export "$key=$val"
    fi
  done
fi

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

DRY_RUN=0
STRIPE_ONLY=0
DB_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --stripe-only) STRIPE_ONLY=1 ;;
    --db-only) DB_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# //;s/^#//'
      exit 0
      ;;
  esac
done

echo "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${BLUE}  MEGA E2E — purge manuelle (filet humain)${NC}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "${YELLOW}  Mode DRY-RUN : aucune modif effective${NC}"
fi
echo "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# ─── 1. Stripe customers + subs ────────────────────────────────────────
if [ "$DB_ONLY" -eq 0 ]; then
  echo "${BLUE}[1/3] Stripe (customers + subs MEGA)${NC}"
  if [ -z "${STRIPE_SECRET_KEY_TEST:-}" ]; then
    echo "${YELLOW}  ⚠ STRIPE_SECRET_KEY_TEST manquante — skip Stripe${NC}"
  elif ! echo "${STRIPE_SECRET_KEY_TEST}" | grep -q '^sk_test_'; then
    echo "${RED}  ✗ STRIPE_SECRET_KEY_TEST n'est pas une clé TEST — REFUS (anti-LIVE)${NC}"
    exit 2
  else
    # Liste les customers e2e-mega-* via curl + jq
    LIST_URL="https://api.stripe.com/v1/customers?limit=100"
    while : ; do
      RESP=$(curl -sf -u "${STRIPE_SECRET_KEY_TEST}:" "$LIST_URL" 2>/dev/null || echo '{}')
      MATCHES=$(echo "$RESP" | jq -r '.data[] | select(.email | test("^e2e-mega-")) | .id' 2>/dev/null || echo "")
      if [ -z "$MATCHES" ]; then
        echo "${GREEN}  ✓ aucun customer MEGA trouvé dans ce batch${NC}"
      else
        for cust_id in $MATCHES; do
          EMAIL=$(echo "$RESP" | jq -r ".data[] | select(.id==\"$cust_id\") | .email" 2>/dev/null || echo "?")
          if [ "$DRY_RUN" -eq 1 ]; then
            echo "  [dry-run] Stripe customer $cust_id ($EMAIL)"
          else
            # Cancel subs actives
            curl -sf -u "${STRIPE_SECRET_KEY_TEST}:" \
              "https://api.stripe.com/v1/subscriptions?customer=${cust_id}&status=all&limit=100" 2>/dev/null \
              | jq -r '.data[] | select(.status != "canceled") | .id' 2>/dev/null \
              | while read sub_id; do
                  [ -z "$sub_id" ] && continue
                  curl -sf -u "${STRIPE_SECRET_KEY_TEST}:" -X DELETE \
                    "https://api.stripe.com/v1/subscriptions/${sub_id}" >/dev/null 2>&1 \
                    && echo "    ↳ cancel sub $sub_id" \
                    || echo "    ↳ ${YELLOW}skip sub $sub_id (déjà canceled ou erreur)${NC}"
                done
            # Delete customer
            curl -sf -u "${STRIPE_SECRET_KEY_TEST}:" -X DELETE \
              "https://api.stripe.com/v1/customers/${cust_id}" >/dev/null 2>&1 \
              && echo "${GREEN}  ✓ deleted customer $cust_id ($EMAIL)${NC}" \
              || echo "${YELLOW}  ⚠ skip customer $cust_id (déjà deleted ?)${NC}"
          fi
        done
      fi
      HAS_MORE=$(echo "$RESP" | jq -r '.has_more' 2>/dev/null || echo "false")
      if [ "$HAS_MORE" != "true" ]; then
        break
      fi
      LAST_ID=$(echo "$RESP" | jq -r '.data[-1].id' 2>/dev/null || echo "")
      if [ -z "$LAST_ID" ] || [ "$LAST_ID" = "null" ]; then
        break
      fi
      LIST_URL="https://api.stripe.com/v1/customers?limit=100&starting_after=${LAST_ID}"
    done
  fi
  echo
fi

# ─── 2. DB Hub staging (purge globale e2e-mega-%) ──────────────────────
if [ "$STRIPE_ONLY" -eq 0 ]; then
  echo "${BLUE}[2/3] DB Hub staging (e2e-mega-%@e2e.veridian.site)${NC}"
  if [ "$DRY_RUN" -eq 1 ]; then
    SQL="SELECT
      (SELECT count(*) FROM hub_app.users WHERE email LIKE 'e2e-mega-%') AS users,
      (SELECT count(*) FROM hub_app.tenants WHERE slug LIKE 'mega-%') AS tenants,
      (SELECT count(*) FROM hub_app.tenant_trials WHERE tenant_id LIKE 'mega-%') AS trials
    ;"
    OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=10 dev-pub \
      "docker exec -i hub-staging-db psql -U hub -d hub -tA -c \"$SQL\"" 2>/dev/null || echo "?|?|?")
    echo "  [dry-run] Résidus DB Hub : $OUT"
  else
    # CAST UUID/TEXT : subscriptions.user_id et tenants.user_id sont UUID,
    # users.id est cuid (String). On lookup via supabase_user_id (UUID bridge).
    SQL="
      DELETE FROM hub_app.tenant_trials WHERE tenant_id LIKE 'mega-%';
      DELETE FROM hub_app.subscriptions WHERE user_id IN (
        SELECT supabase_user_id::uuid FROM hub_app.users
        WHERE email LIKE 'e2e-mega-%' AND supabase_user_id IS NOT NULL
      );
      DELETE FROM hub_app.stripe_events WHERE customer_id IN (
        SELECT stripe_customer_id FROM hub_app.users
        WHERE email LIKE 'e2e-mega-%' AND stripe_customer_id IS NOT NULL
      );
      DELETE FROM hub_app.audit_log WHERE target_id LIKE 'mega-%' OR actor LIKE '%e2e-mega-%';
      DELETE FROM hub_app.invitations WHERE workspace_id IN (
        SELECT id FROM hub_app.workspaces WHERE owner_id IN (
          SELECT id FROM hub_app.users WHERE email LIKE 'e2e-mega-%'
        )
      );
      DELETE FROM hub_app.tenant_members WHERE user_id IN (
        SELECT supabase_user_id FROM hub_app.users
        WHERE email LIKE 'e2e-mega-%' AND supabase_user_id IS NOT NULL
      ) OR tenant_id IN (
        SELECT id::text FROM hub_app.tenants WHERE slug LIKE 'mega-%'
      );
      DELETE FROM hub_app.tenants WHERE slug LIKE 'mega-%'
        OR user_id IN (
          SELECT supabase_user_id::uuid FROM hub_app.users
          WHERE email LIKE 'e2e-mega-%' AND supabase_user_id IS NOT NULL
        );
      DELETE FROM hub_app.workspace_members WHERE user_id IN (
        SELECT id FROM hub_app.users WHERE email LIKE 'e2e-mega-%'
      );
      DELETE FROM hub_app.workspaces WHERE owner_id IN (
        SELECT id FROM hub_app.users WHERE email LIKE 'e2e-mega-%'
      );
      DELETE FROM hub_app.accounts WHERE user_id IN (
        SELECT id FROM hub_app.users WHERE email LIKE 'e2e-mega-%'
      );
      DELETE FROM hub_app.sessions WHERE user_id IN (
        SELECT id FROM hub_app.users WHERE email LIKE 'e2e-mega-%'
      );
      DELETE FROM hub_app.users WHERE email LIKE 'e2e-mega-%';
    "
    if ssh -o BatchMode=yes -o ConnectTimeout=10 dev-pub \
        "docker exec -i hub-staging-db psql -U hub -d hub -tA -v ON_ERROR_STOP=1" <<< "$SQL" \
        >/dev/null 2>&1; then
      echo "${GREEN}  ✓ DB Hub purgée${NC}"
    else
      echo "${RED}  ✗ DB Hub purge failed${NC}"
    fi
  fi
  echo

  # ─── 3. DBs downstream (Notifuse + Prospection) ────────────────────────
  echo "${BLUE}[3/3] DBs downstream (Notifuse + Prospection)${NC}"
  for app in notifuse prospection; do
    container="${app}-staging-db"
    if [ "$DRY_RUN" -eq 1 ]; then
      OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=10 dev-pub \
        "docker exec -i ${container} psql -U ${app} -d ${app} -tA -c \"
          SELECT
            (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='workspaces') AS has_ws,
            (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='users') AS has_users
          ;\"" 2>/dev/null || echo "?|?")
      echo "  [dry-run] ${app} schema : $OUT"
    else
      SQL="
        DELETE FROM public.workspaces WHERE id LIKE 'mega-%';
        DELETE FROM public.users WHERE email LIKE 'e2e-mega-%';
      "
      if ssh -o BatchMode=yes -o ConnectTimeout=10 dev-pub \
          "docker exec -i ${container} psql -U ${app} -d ${app} -tA" <<< "$SQL" \
          >/dev/null 2>&1; then
        echo "${GREEN}  ✓ DB ${app} purgée${NC}"
      else
        echo "${YELLOW}  ⚠ DB ${app} purge échouée (container down ou table absente — pas critique)${NC}"
      fi
    fi
  done
  echo
fi

# ─── Récap ─────────────────────────────────────────────────────────────
echo "${BLUE}━━━ Récap résidus post-purge ━━━${NC}"
SQL_COUNT="SELECT
  (SELECT count(*) FROM hub_app.users WHERE email LIKE 'e2e-mega-%') AS users,
  (SELECT count(*) FROM hub_app.tenants WHERE slug LIKE 'mega-%') AS tenants,
  (SELECT count(*) FROM hub_app.tenant_trials WHERE tenant_id LIKE 'mega-%') AS trials
;"
RESIDUES=$(ssh -o BatchMode=yes -o ConnectTimeout=10 dev-pub \
  "docker exec -i hub-staging-db psql -U hub -d hub -tA -c \"$SQL_COUNT\"" 2>/dev/null || echo "?|?|?")
echo "  DB Hub résidus : $RESIDUES (users|tenants|trials)"
echo
echo "${GREEN}✓ Purge manuelle terminée${NC}"
