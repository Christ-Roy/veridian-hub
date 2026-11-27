#!/usr/bin/env bash
# lourd-ou-local.sh <commande...> : une étape lourde du pre-push, hors du bastion quand on y est (parente, 26/11 : charge 13 à 23
# pour 6 cœurs, faite des crochets des sessions). `lourd-si-bastion` la lance sur rise ou node02 ; ailleurs (CI, autre nœud) sur place.
# Contrat : 0 passe, 1 échoue (tout code non nul de la commande est ramené à 1 : tsc sort en 2 et ne doit jamais passer pour un
# NON ABOUTI). Si lourd n'a rien fait tourner (2 + « NON ABOUTI »), l'étape est REJOUÉE ici en nice 19 : jamais de push sans elle.
set -u
cmd=$(printf '%q ' "$@")
interne="$cmd; rc=\$?; [ \$rc -eq 0 ] || exit 1"
if command -v lourd-si-bastion >/dev/null 2>&1; then
  journal=$(mktemp); rc=0
  lourd-si-bastion bash -c "$interne" 2> >(tee "$journal" >&2) || rc=$?
  wait
  if [ "$rc" -eq 2 ] && grep -q "NON ABOUTI" "$journal"; then
    echo "lourd-ou-local : lourd n'a rien fait tourner, l'étape est rejouée ici en nice 19" >&2
    rc=0; nice -n 19 bash -c "$interne" || rc=$?
  fi
  rm -f "$journal"
  [ "$rc" -eq 0 ] && exit 0 || exit 1
fi
rc=0; nice -n 19 bash -c "$interne" || rc=$?
[ "$rc" -eq 0 ] && exit 0 || exit 1
