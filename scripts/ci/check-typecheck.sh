#!/usr/bin/env sh
# Typecheck avant le push : le build Next vérifie les types (scripts/ compris) et la CI tombait là, 20 minutes après
# le push (22/11, VER-203 : un script de scripts/ non typé). e2e/ est exclu : ses erreurs Playwright sont anciennes et
# le build ne le lit pas. nice 19 : le bastion porte la coordination de la flotte.
set -u
sortie="$(nice -n 19 pnpm -s tsc --noEmit -p . 2>&1)"
erreurs="$(printf '%s\n' "$sortie" | grep -E '^[^ ].*error TS[0-9]+' | grep -v '^e2e/' || true)"
if [ -n "$erreurs" ]; then
  printf '%s\n' "$erreurs" >&2
  echo "typecheck — ÉCHEC : erreurs de type hors e2e/ (le build de la CI les refusera)." >&2
  exit 1
fi
echo "typecheck — OK (hors e2e/)."
