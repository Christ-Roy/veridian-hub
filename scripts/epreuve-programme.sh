#!/usr/bin/env bash
# Épreuve d'enfermement du mode programme, sur ce qui est SERVI (docs/CONTRAT-MCP.md) : un exécuteur volontairement compromis
# (programme/epreuve.mjs, du code arbitraire sans QuickJS) tourne dans la prison, pendant qu'un autre programme tourne à côté,
# et le même code tourne dans le conteneur du Hub comme contrôle positif. Aucune valeur n'est lue ni affichée.
#   scripts/epreuve-programme.sh [hub|hub-staging]
# Sortie : 0 la prison n'obtient rien · 1 elle obtient quelque chose · 2 non abouti (dont : le témoin n'obtient pas ce qu'il doit)
set -uo pipefail
JOB=${1:-hub}
ICI=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
alloc() { nomad-v raw job status "$JOB" 2>/dev/null | awk -v g="$1" '/^Allocations/{f=1} f && $3==g && / run +running/ {print $1; exit}'; }
H=$(alloc stack); P=$(alloc programme); P=${P:-$H}
[ -n "$P" ] && [ -n "$H" ] || { echo "NON ABOUTI : allocation programme ($P) ou stack ($H) absente"; exit 2; }
B64=$(base64 -w0 "$ICI/programme/epreuve.mjs")
PRISON='/opt/programme/chroot --userspec=UID:UID --groups= /opt/programme/prison /node'
jouer() { nomad-v raw alloc exec -task "$1" "$2" sh -c "$3" 2>/dev/null | grep -E '^\{' | tail -1; }
EPREUVE=$(jouer "$JOB-programme-moteur" "$P" "${PRISON//UID/20009} -e 'setTimeout(()=>{},20000)' & V=\$!; sleep 1; echo $B64 | base64 -d | env -i ${PRISON//UID/20010} --input-type=module - \$V; kill -9 \$V 2>/dev/null")
TEMOIN=$(jouer "$JOB" "$H" "sleep 8 & V=\$!; echo $B64 | base64 -d | node --input-type=module - \$V")
[ -n "$EPREUVE" ] && [ -n "$TEMOIN" ] || { echo "NON ABOUTI : pas de réponse (prison ${#EPREUVE}, témoin ${#TEMOIN})"; exit 2; }
EPREUVE="$EPREUVE" TEMOIN="$TEMOIN" python3 - <<'PY'
import json, os, sys
e, t = json.loads(os.environ['EPREUVE']), json.loads(os.environ['TEMOIN'])
# Ce que le témoin DOIT obtenir : sinon l'épreuve ne mesure rien.
du = ["secret:env AUTH_SECRET", "secret:/proc/self/environ", "disque:/etc/passwd", "disque:/proc", "systeme:shell", "voisins:un processus plus ancien", "voisins:le programme d'un autre compte", "reseau:internet", "reseau:base du Hub", "reseau:Hub en boucle locale"]
for k in e: print(f"{'ECHEC' if e[k] else 'ok   '} prison={e[k]} temoin={t.get(k)}  {k}")
print(f"prison {sum(e.values())}/{len(e)} · témoin {sum(t.values())}/{len(t)}")
manque = [k for k in du if not t.get(k)]
if manque: print("NON ABOUTI : le témoin n'obtient pas", manque); sys.exit(2)
sys.exit(1 if any(e.values()) else 0)
PY
