#!/usr/bin/env bash
#
# Postgres local jetable pour le dev du Hub.
#
# POURQUOI CE SCRIPT
#   Le Hub ne démarre pas sans DATABASE_URL joignable, et le repo contenait
#   trois URL contradictoires, toutes mortes (5433/veridian_core dans les
#   .env.local, 5432/veridian dans ce README, supabase-db dans
#   .env.dev.example). Une seule commande fait foi désormais.
#
# 🔴 LE PIÈGE DU PORT 5433 — À LIRE AVANT DE LE « CORRIGER »
#   Sur une machine qui fait tourner le cluster Nomad (bastion Contabo), le
#   port 5433 est le port statique du Patroni `hub-staging-db`. La règle DNAT
#   posée par CNI est évaluée AVANT celle de Docker :
#
#     CNI-HOSTPORT-DNAT --dport 5433 -> 172.26.64.217:5433   (Patroni staging)
#     DOCKER            --dport 5433 -> 172.17.0.x:5432      (ton conteneur)
#
#   Conséquence : un conteneur local publié sur 5433 démarre sans erreur, mais
#   TOUTE connexion vers localhost:5433 part sur la base staging du cluster,
#   qui possède elle aussi un rôle `hub`. D'où le message trompeur
#   « password authentication failed for user "hub" » avec le bon mot de passe.
#
#   Et le vrai danger n'est pas l'erreur : c'est le cas où ça « marche ». Un
#   dev qui colle le mot de passe staging (il est dans ~/credentials) croit
#   travailler en local alors qu'il écrit dans la base staging.
#
#   → On utilise donc 5439. Ne repasse pas sur 5433 sans avoir vérifié
#     `sudo iptables -t nat -S | grep 5433`.
#
# CE QU'IL FAIT
#   1. Démarre un Postgres 16 nommé `hub-dev-pg`, avec les MÊMES user/base/
#      schema qu'en staging et en prod (hub / hub / hub_app).
#   2. Vérifie que la connexion depuis l'hôte tombe bien sur LUI (cf. piège).
#   3. Applique les migrations Prisma.
#   Idempotent : relançable autant de fois que voulu.
#
# CE QU'IL N'EST PAS
#   Une base de prod ni une copie du staging. Elle est vide, locale, sans TLS,
#   n'écoute que sur 127.0.0.1, et son mot de passe est volontairement trivial
#   et public : il ne protège rien. N'y mets aucune donnée réelle.
#
# USAGE
#   ./scripts/dev/db-up.sh            # démarre + migre
#   ./scripts/dev/db-up.sh --reset    # DÉTRUIT les données et repart de zéro
#   HUB_DEV_DB_PORT=5441 ./scripts/dev/db-up.sh   # si 5439 est pris chez toi
#
set -euo pipefail

CONTAINER=hub-dev-pg
VOLUME=hub-dev-pg-data
IMAGE=postgres:16-alpine          # aligné sur spilo-16 (Patroni) staging/prod
PORT="${HUB_DEV_DB_PORT:-5439}"   # PAS 5433 — cf. « LE PIÈGE » ci-dessus
DB_USER=hub
DB_NAME=hub
# Mot de passe de dev local, non secret — cf. « CE QU'IL N'EST PAS ».
DB_PASSWORD=hub-local-dev

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=hub_app"

cd "$(dirname "$0")/../.."

if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker ne répond pas. Démarre-le puis relance ce script." >&2
  exit 1
fi

if [ "${1:-}" = "--reset" ]; then
  echo "→ Reset : suppression du conteneur et du volume"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "→ Conteneur $CONTAINER déjà présent, démarrage"
  docker start "$CONTAINER" >/dev/null
else
  echo "→ Création du conteneur $CONTAINER ($IMAGE) sur le port $PORT"
  docker run -d \
    --name "$CONTAINER" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    -p "127.0.0.1:${PORT}:5432" \
    -v "${VOLUME}:/var/lib/postgresql/data" \
    "$IMAGE" >/dev/null
fi

echo -n "→ Attente de Postgres "
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    echo "— prêt"
    break
  fi
  echo -n "."
  sleep 1
done

if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo
  echo "✗ Postgres n'a pas démarré. Diagnostic : docker logs $CONTAINER" >&2
  exit 1
fi

# Fusible anti-détournement : on vérifie que localhost:$PORT tombe bien sur CE
# conteneur, et pas sur une base du cluster (cf. « LE PIÈGE » en en-tête).
# Sans ce contrôle, l'échec se manifeste plus tard sous forme d'une erreur
# d'authentification incompréhensible — ou pire, ne se manifeste pas du tout.
echo "→ Vérification que le port $PORT n'est pas détourné"
MARKER="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "select 'hub-dev-' || (select setting from pg_settings where name='data_directory')")"
if ! HOST_MARKER="$(docker run --rm --network host -e PGPASSWORD="$DB_PASSWORD" "$IMAGE" \
      psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
      "select 'hub-dev-' || (select setting from pg_settings where name='data_directory')" 2>/dev/null)"; then
  cat <<EOF >&2

✗ Impossible de joindre la base sur localhost:${PORT} depuis l'hôte, alors que
  le conteneur, lui, répond très bien.

  C'est la signature d'une collision de port : une règle DNAT (cluster Nomad,
  VPN, tunnel) capte ce port avant Docker. Vérifie avec :

      sudo iptables -t nat -S | grep ${PORT}

  Puis relance sur un autre port :

      HUB_DEV_DB_PORT=5441 ./scripts/dev/db-up.sh --reset

EOF
  exit 1
fi
if [ "$HOST_MARKER" != "$MARKER" ]; then
  echo "✗ localhost:${PORT} ne mène PAS à ton conteneur — port détourné." >&2
  echo "  Relance avec HUB_DEV_DB_PORT=5441 ./scripts/dev/db-up.sh --reset" >&2
  exit 1
fi

echo "→ Application des migrations Prisma"
DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy

cat <<EOF

✓ Base de dev prête.

  DATABASE_URL=${DATABASE_URL}

  Cette ligne doit figurer dans ton .env.local (fichier ignoré par git).
  Ensuite : pnpm dev

  Créer un utilisateur de test : node scripts/dev/seed-dev-user.mjs
  Repartir de zéro            : ./scripts/dev/db-up.sh --reset
EOF
