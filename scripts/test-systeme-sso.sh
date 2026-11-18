#!/usr/bin/env bash
# Batterie système SSO : une commande, un résultat à trois états.
#   bash scripts/test-systeme-sso.sh            # toute la batterie (prod)
#   bash scripts/test-systeme-sso.sh 00-        # un sous-ensemble (filtre Playwright)
# Sortie : 0 tout passe (ou attendu rouge) · 1 au moins un échec · 2 au moins un cas non abouti.
# Lance un Chromium en `nice 19`, un seul worker. À jouer depuis le bastion (la version servie
# se lit par `nomad job inspect`). Aucun secret dans le dépôt : ADMIN_SECRET vient de
# l'environnement, ou du fichier de credentials de la machine, lu à l'exécution.
set -uo pipefail
cd "$(dirname "$0")/../e2e/systeme-sso"

# Le jeton Nomad hérité du shell peut être révoqué par une rotation (07/11) : on relit le jeton de
# lecture dans le fichier qui fait foi, sans jamais l'afficher.
if [ -r "$HOME/credentials/nomad-bastion.env" ]; then
  LU="$(set -a; . "$HOME/credentials/nomad-bastion.env" >/dev/null 2>&1; printf '%s' "${NOMAD_READ_TOKEN:-}")"
  [ -n "$LU" ] && export NOMAD_TOKEN="$LU"
  unset LU
fi

# Une seule batterie à la fois : elles partagent .run et le plafond de l'API admin.
# Le verrou se prend AVANT tout effacement : un second lancement effaçait le monde de la batterie
# en cours, qui recréait alors son compte A sous la même adresse et tombait sur « Ce lien a déjà
# été utilisé » (08/11, reproduit : le second lancement sort en NON ABOUTI, le monde a disparu).
mkdir -p .run
exec 9>.run/verrou
flock -n 9 || { echo "✗ NON ABOUTI : une autre batterie tourne déjà dans ce dossier"; exit 2; }
rm -f .run/versions.json .run/resultat.* .run/monde-*.json .run/restes.json  # le registre des comptes est conservé : un crash ne doit rien orpheliner

# Le Hub doit être là avant de mesurer quoi que ce soit (un déploiement le coupe ~30 s).
HUB="${HUB_URL:-https://app.veridian.site}"
FIN=$(( $(date +%s) + ${SSO_ATTENTE_HUB:-180} ))
until curl -fsS -m 10 "$HUB/api/health" 2>/dev/null | grep -q '"status":"ok"'; do
  if [ "$(date +%s)" -ge "$FIN" ]; then
    echo "✗ NON ABOUTI : le Hub ne répond pas sur $HUB/api/health. Vérifier HUB_URL et le déploiement en cours."
    exit 2
  fi
  sleep 5
done

# Pas de mesure pendant un déploiement du Hub : deux versions servent en même temps, un échec n'y
# dirait rien de la version testée. On attend la fin (même délai que ci-dessus), sinon NON ABOUTI.
# Nomad illisible = non vérifiable, donc non abouti (SSO_SANS_NOMAD=1 pour jouer hors du bastion).
# Exception : `SSO_PENDANT_DEPLOIEMENT=1` joue le cas 10 (inscription pendant le déploiement) exprès.
if [ "${SSO_SANS_NOMAD:-}" != 1 ] && [ -z "${HUB_URL:-}" ] && [ "${SSO_PENDANT_DEPLOIEMENT:-}" != 1 ]; then
  until ETAT="$(nomad job deployments -t '{{range .}}{{.Status}}{{"\n"}}{{end}}' hub 2>/dev/null | head -1)" && [ -n "$ETAT" ] && [ "$ETAT" != running ]; do
    if [ "$(date +%s)" -ge "$FIN" ]; then
      [ -n "$ETAT" ] && QUOI="un déploiement du Hub est en cours" || QUOI="les déploiements du Hub sont illisibles dans Nomad"
      echo "✗ NON ABOUTI : $QUOI. Relancer après, ou SSO_SANS_NOMAD=1 hors du bastion."
      exit 2
    fi
    sleep 5
  done
fi

# @playwright/test : celui du dépôt s'il est installé, sinon un jeu de modules déjà présent sur la machine.
if [ ! -e node_modules/@playwright/test ] && [ ! -e ../../node_modules/@playwright/test ]; then
  SRC="${PW_MODULES:-$HOME/veridian.site/node_modules}"
  [ -e "$SRC/@playwright/test" ] || { echo "✗ @playwright/test introuvable (pnpm install, ou PW_MODULES=<node_modules>)"; exit 2; }
  ln -sfn "$SRC" node_modules
fi

# Chromium : le plus récent du cache Playwright si aucun n'est imposé.
if [ -z "${PW_CHROMIUM:-}" ]; then
  PW_CHROMIUM="$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -1)"
  export PW_CHROMIUM
fi

# Le lanceur est à côté (lien ci-dessus) ou à la racine du dépôt après `pnpm install`.
PW_BIN=node_modules/.bin/playwright
[ -e "$PW_BIN" ] || PW_BIN=../../node_modules/.bin/playwright
nice -n 19 "$PW_BIN" test -c playwright.config.ts "$@"
PW=$?

[ -f .run/resultat.json ] || { echo "✗ NON ABOUTI : aucun résultat écrit (code Playwright $PW)"; exit 2; }
node -e '
const r=require("./.run/resultat.json").compte;
// Zero cas joue (filtre sans correspondance) : rien de mesure, donc pas un succes.
if(Object.values(r).reduce((x,y)=>x+y,0)===0){console.error("✗ NON ABOUTI : aucun cas joué");process.exit(2)}
const fs=require("fs");
// Le teardown a mesuré ce que la prod garde de cette batterie : un reste fait échouer la commande.
let v=null;try{v=JSON.parse(fs.readFileSync("./.run/restes.json","utf8"))}catch{}
if(!v){console.error("✗ NON ABOUTI : aucun verdict de nettoyage écrit");process.exit(2)}
const restes=[...(v.echecs||[]),...(v.restes||[])];
if(restes.length){console.error("✗ RESTES EN PROD ("+restes.length+") : "+restes.join(" · "));process.exit(1)}
if((r.ECHOUE||0)>0)process.exit(1);
if(v.nonAbouti){console.error("⚪ RESTES NON MESURÉS : "+v.nonAbouti);process.exit(2)}
console.log("✅ RESTES : 0 mesuré en prod");
process.exit((r.NON_ABOUTI||0)>0?2:0)'
