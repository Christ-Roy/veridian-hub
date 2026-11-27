#!/usr/bin/env bash
# Batterie système HORS du bastion (parente et Robert, 27/11 : « on sur sature bastion sans réfléchir »).
#   bash scripts/batterie-lourd.sh 57-        un filtre Playwright, comme scripts/test-systeme-sso.sh
# Sur le bastion, ce lanceur ne fait que LIRE : l'état du Hub (santé, déploiement Nomad), les versions servies (nomad job inspect), les secrets
# (sourcés en mémoire). Tout le calcul (Playwright, Chromium, Node) part sur node02 par `lourd --navigateur` ; les secrets voyagent par le
# tube en mémoire de lourd, jamais dans un fichier ni dans la commande ; aucun jeton Nomad ne quitte le bastion. Ensuite, `.run` revient
# ici (résultat, captures, restes), pour qu'on le lise comme avant.
# Cas qui restent au bastion (un outil ou un fichier qui n'existe que là) : 10, 12, 13, 16, 20, 27, 30, 32, 39, 41, 44, 46, 48, 49, 58 et ceux
# qui créent un compte Analytics (script Rybbit de ~/.claude) ; sous lourd ils disent NON ABOUTI, jamais un faux vert.
# Sortie : celle de la batterie (0 · 1 · 2) ; 2 aussi si lourd n'a rien fait tourner.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
[ $# -gt 0 ] || { echo "usage : bash scripts/batterie-lourd.sh <filtre Playwright> (ex. 57-)" >&2; exit 2; }
RUN=e2e/systeme-sso/.run
mkdir -p "$RUN"

# 1. Le Hub répond, et aucun déploiement n'est en cours (jeton de LECTURE, lu ici, jamais transmis).
HUB="${HUB_URL:-https://app.veridian.site}"
FIN=$(( $(date +%s) + ${SSO_ATTENTE_HUB:-180} ))
until curl -fsS -m 10 "$HUB/api/health" 2>/dev/null | grep -q '"status":"ok"'; do
  [ "$(date +%s)" -ge "$FIN" ] && { echo "✗ NON ABOUTI : le Hub ne répond pas sur $HUB/api/health"; exit 2; }
  sleep 5
done
if [ -r "$HOME/credentials/nomad-bastion.env" ]; then
  LU="$(set -a; . "$HOME/credentials/nomad-bastion.env" >/dev/null 2>&1; printf '%s' "${NOMAD_READ_TOKEN:-}")"
  [ -n "$LU" ] && export NOMAD_TOKEN="$LU"; unset LU
fi
if [ -z "${HUB_URL:-}" ] && [ "${SSO_PENDANT_DEPLOIEMENT:-}" != 1 ]; then
  until ETAT="$(nomad job deployments -t '{{range .}}{{.Status}}{{"\n"}}{{end}}' hub 2>/dev/null | head -1)" && [ -n "$ETAT" ] && [ "$ETAT" != running ]; do
    [ "$(date +%s)" -ge "$FIN" ] && { echo "✗ NON ABOUTI : déploiement du Hub en cours ou illisible dans Nomad"; exit 2; }
    sleep 5
  done
fi

# 2. Les versions servies, lues ici et écrites dans .run/versions.json, que lourd copie avec l'arbre (lib/versions.ts le lit en premier).
image() { nomad job inspect -json "$1" 2>/dev/null | grep -oE '"[Ii]mage": *"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' | grep -vE 'postgres|clickhouse|redis|pgbackrest' | sort -u | paste -sd'+' | sed 's/+/ + /g'; }
{
  printf '{'
  premier=1
  for paire in hub:hub prospection:prospection notifuse:notifuse analytics:analytics-rybbit twenty:; do
    cle=${paire%%:*}; job=${paire#*:}; lu=""; [ -n "$job" ] && lu="$(image "$job")"
    [ $premier = 1 ] || printf ','; premier=0
    if [ -n "$lu" ]; then printf '"%s":{"lu":"%s","source":"nomad job inspect (bastion)"}' "$cle" "$lu"; else printf '"%s":{"lu":null,"source":"non lue"}' "$cle"; fi
  done
  printf '}\n'
} > "$RUN/versions.json"

# 3. Les secrets : sourcés en mémoire, puis NOMMÉS pour lourd (seuls ceux présents). Jamais affichés.
f="$HOME/credentials/.all-creds.env"
[ -r "$f" ] || { echo "✗ NON ABOUTI : ~/credentials/.all-creds.env illisible"; exit 2; }
set -a; . "$f" >/dev/null 2>&1; set +a
NOMS=""
for n in ADMIN_SECRET ADMIN_SECRET_STAGING ACADEMY_HUB_API_SECRET ANALYTICS_HUB_API_SECRET CRM_HUB_API_SECRET CRM_HUB_API_SECRET_PROD \
         CRM_HUB_API_SECRET_STAGING HUB_INVITATION_SECRET_NOTIFUSE_PROD NOTIFUSE_HUB_API_SECRET NOTIFUSE_HUB_WEBHOOK_SECRET OPENROUTER_API_KEY \
         PROSPECTION_TENANT_API_SECRET PROSPECTION_HUB_API_SECRET RYBBIT_PROD_UI_EMAIL RYBBIT_PROD_UI_PASSWORD STRIPE_SECRET_KEY_TEST STRIPE_WEBHOOK_SECRET_TEST; do
  [ -n "${!n:-}" ] && NOMS="${NOMS:+$NOMS,}$n"
done

# 4. Le calcul, sur node02. SSO_SUR_LOURD : le lanceur interne saute ce qui a été lu ici (santé, Nomad, versions) et prend le Chromium local.
# Les réglages de la batterie (SSO_SABOTAGE, SSO_MON_IA_APP, HUB_URL…) ne sont pas secrets : ils partent dans la commande, lisible dans Nomad.
REGLAGES=""
for v in $(compgen -v | grep -E '^(SSO_[A-Z0-9_]+|HUB_URL|ACADEMY_URL)$'); do
  case "$v" in SSO_NAVIGATEUR|SSO_NAV_DUREE|SSO_SUR_LOURD|SSO_SANS_NOMAD) continue ;; esac
  REGLAGES+="export $(printf '%s=%q' "$v" "${!v}"); "
done
lourd --navigateur --secrets "$NOMS" bash -c "${REGLAGES}"'cd e2e/systeme-sso && SSO_SUR_LOURD=1 SSO_SANS_NOMAD=1 bash ../../scripts/test-systeme-sso.sh "$@"' _ "$@"
RC=$?

# 5. .run revient : résultat, captures, restes mesurés. Le chemin est celui de lourd (dépôt, genre « nav », clé du chemin).
RACINE="$(git rev-parse --show-toplevel)"
CLE="$(printf '%s' "$RACINE" | sha256sum | cut -c1-10)"
rsync -a -e "ssh -o BatchMode=yes" "node02:/home/ubuntu/lourd/$(basename "$RACINE")-nav-$CLE/e2e/systeme-sso/.run/" "$RUN/" 2>/dev/null \
  || echo "⚠ .run non rapatrié de node02 : le résultat ci-dessus est celui de lourd, sans les captures"
[ "$RC" = 255 ] && { echo "✗ NON ABOUTI : lourd n'a rien fait tourner"; exit 2; }
exit "$RC"
