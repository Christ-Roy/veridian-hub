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

mkdir -p .run && rm -f .run/versions.json .run/resultat.* .run/monde-*.json  # le registre des comptes est conservé : un crash ne doit rien orpheliner

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
process.exit((r.ECHOUE||0)>0?1:(r.NON_ABOUTI||0)>0?2:0)'
