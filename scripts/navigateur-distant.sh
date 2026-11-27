#!/usr/bin/env bash
# Navigateur distant de la batterie système : `playwright run-server` sur node02 (via `lourd --navigateur`),
# le bastion ne fait tourner que le processus Node de la batterie.
#   bash scripts/navigateur-distant.sh            démarre, attend, écrit le wsEndpoint dans .run/navigateur/ws
#   bash scripts/navigateur-distant.sh --sonde [URL]   se relie au serveur, lit URL (défaut : /api/health du Hub)
#   bash scripts/navigateur-distant.sh --stop     arrête le job, le tunnel, le suivi
# Sortie : 0 · 1 sans objet · 2 NON ABOUTI (navigateur injoignable, jamais un échec de cas).
# Réseau : le conteneur est sur le pont Docker de node02, port non publié. Le bastion le joint par un tunnel ssh
# (127.0.0.1 local, node02 ensuite vers l'IP du conteneur) : rien n'écoute sur le réseau public ni sur le tailnet.
# Le chemin du serveur est aléatoire (secret de session, lisible dans les meta du job Nomad, sur le tailnet seulement),
# sa durée de vie est bornée (SSO_NAV_DUREE, 3600 s). Même version de Playwright que le dépôt (le protocole refuse un écart).
# Cas dépendant de l'IP : les pages sortent depuis node02, `request` et `context.request` depuis le bastion.
set -uo pipefail
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
D="${SSO_NAV_DIR:-$RACINE/e2e/systeme-sso/.run/navigateur}"
PORT_CONTENEUR=9323
DUREE="${SSO_NAV_DUREE:-3600}"
ATTENTE="${SSO_NAV_ATTENTE:-900}"
# Le nœud est celui où Nomad a placé l'allocation (lu sur elle), jamais figé ici : `lourd --navigateur` choisit (infra, 27/11 : six lancements
# empilés derrière un node02 plein). Nom Nomad → alias ssh : veridian-node-02 → node02, veridian-rise-01 → rise.
NOEUD=""
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8)
dit() { echo "[navigateur-distant] $*" >&2; }
nomad_lourd() ( set -a; . "${LOURD_ENV:-$HOME/credentials/nomad-lourd.env}" >/dev/null 2>&1; set +a; nomad "$@" )

sonde() {
  local url="${1:-${HUB_URL:-https://app.veridian.site}/api/health}" ws="${PW_WS:-$(cat "$D/ws" 2>/dev/null)}"
  [ -n "$ws" ] || { dit "aucun wsEndpoint : NON ABOUTI"; return 2; }
  local mod="${PW_MODULES:-}"
  [ -n "$mod" ] || for c in "$RACINE/node_modules" "$RACINE/e2e/systeme-sso/node_modules" "$HOME/veridian.site/node_modules"; do [ -e "$c/@playwright/test" ] && mod="$c" && break; done
  [ -n "$mod" ] || { dit "@playwright/test introuvable : NON ABOUTI"; return 2; }
  NODE_PATH="$mod" WS="$ws" URL="$url" timeout 60 node -e '
const { chromium } = require("@playwright/test");
(async () => {
  let b;
  try { b = await chromium.connect(process.env.WS, { timeout: 20000 }); }
  catch (e) { console.error("injoignable : " + String(e.message).split("\n")[0]); process.exit(2); }
  const p = await b.newPage();
  const r = await p.goto(process.env.URL, { timeout: 30000 });
  console.log("navigateur " + b.version() + " : " + r.status() + " " + process.env.URL);
  console.log((await p.locator("body").innerText()).slice(0, 200));
  await b.close();
})().catch((e) => { console.error("sonde : " + String(e.message).split("\n")[0]); process.exit(2); });'
  local c=$?; [ $c -eq 0 ] || c=2; return $c
}

arreter() {
  [ -d "$D" ] || return 0
  local id; id="$(cat "$D/job" 2>/dev/null)"
  for f in tunnel lourd; do
    [ -s "$D/$f.pid" ] && kill "$(cat "$D/$f.pid")" 2>/dev/null
    rm -f "$D/$f.pid"
  done
  [ -n "$id" ] && nomad_lourd job stop -detach "$id" >/dev/null 2>&1 && dit "job $id arrêté"
  rm -f "$D/ws" "$D/job"
  return 0
}

demarrer() {
  [ -f "$RACINE/package.json" ] || { dit "à lancer depuis un dépôt : NON ABOUTI"; return 2; }
  arreter; mkdir -p "$D"; chmod 700 "$D"
  local alea; alea="$(openssl rand -hex 16)"
  local lp; lp="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
  # Depuis la racine du dépôt : lourd y copie l'arbre, installe ses dépendances, donc la même version de Playwright.
  ( cd "$RACINE" && exec lourd --navigateur sh -c "exec timeout -k 5 $DUREE npx --no-install playwright run-server --host 0.0.0.0 --port $PORT_CONTENEUR --path /$alea" ) >"$D/lourd.log" 2>&1 &
  echo $! >"$D/lourd.pid"
  local fin=$(( $(date +%s) + ATTENTE )) id="" ip="" ctn="" alloc="" rep=""
  while [ "$(date +%s)" -lt "$fin" ]; do
    kill -0 "$(cat "$D/lourd.pid")" 2>/dev/null || { dit "lourd s'est arrêté avant que le serveur réponde ($(tail -n 2 "$D/lourd.log" | tr '\n' ' ')) : NON ABOUTI"; arreter; return 2; }
    [ -n "$id" ] || { id="$(sed -n 's/^\[lourd\] \(lourd-navigateur\/dispatch-[^,]*\),.*/\1/p' "$D/lourd.log" | head -1)"; [ -z "$id" ] || echo "$id" >"$D/job"; }
    if [ -n "$id" ] && [ -z "$ip" ]; then
      read -r alloc nom <<<"$(nomad_lourd job allocs -json "$id" 2>/dev/null | python3 -c 'import sys,json;a=json.load(sys.stdin);print(a[0]["ID"], a[0].get("NodeName","")) if a else print("")' 2>/dev/null)"
      case "$nom" in *node-02*) NOEUD=node02 ;; *rise*) NOEUD=rise ;; "") : ;; *) dit "allocation placée sur un nœud inconnu ($nom) : NON ABOUTI"; arreter; return 2 ;; esac
      [ -z "$alloc" ] || [ -z "$NOEUD" ] || ip="$("${SSH[@]}" "$NOEUD" "n=\$(docker ps --format '{{.Names}}' | grep -- '$alloc' | grep -v garde | head -1); [ -n \"\$n\" ] && docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \"\$n\"" 2>/dev/null)"
    fi
    if [ -n "$ip" ] && [ ! -s "$D/tunnel.pid" ]; then
      "${SSH[@]}" "$NOEUD" true 2>/dev/null || { sleep 5; continue; }
      ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N -L "127.0.0.1:$lp:$ip:$PORT_CONTENEUR" "$NOEUD" &
      echo $! >"$D/tunnel.pid"; sleep 1
    fi
    if [ -s "$D/tunnel.pid" ]; then
      # Un TCP ouvert sur le tunnel ne prouve rien : on exige la poignée de main WebSocket (101) du serveur Playwright.
      rep="$(curl -s -i -m 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:$lp/$alea" 2>/dev/null | head -1)"
      case "$rep" in *101*) printf 'ws://127.0.0.1:%s/%s' "$lp" "$alea" >"$D/ws"; chmod 600 "$D/ws"; dit "serveur prêt sur $NOEUD (job $id)"; return 0 ;; esac
    fi
    sleep 5
  done
  # L'étape qui a manqué, pour que le NON ABOUTI se diagnostique sans rejouer (26/11 : 15 min muettes, serveur pourtant à l'écoute).
  dit "serveur injoignable après ${ATTENTE} s : NON ABOUTI (job=${id:-aucun} alloc=${alloc:-aucune} ip=${ip:-aucune} tunnel=$([ -s "$D/tunnel.pid" ] && echo ouvert || echo absent) dernière réponse=$(printf %s "${rep:-aucune}" | head -1 | tr -d "\r" | cut -c1-60))"; arreter; return 2
}

case "${1:-}" in
  --stop) arreter ;;
  --sonde) shift; sonde "$@" ;;
  ""|--demarrer) demarrer ;;
  *) dit "usage : [--demarrer|--sonde [URL]|--stop]"; exit 1 ;;
esac
