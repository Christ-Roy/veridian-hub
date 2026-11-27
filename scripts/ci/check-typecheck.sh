#!/usr/bin/env bash
# Aucune erreur de type hors e2e/ : le build de la CI vérifie les types, scripts/ compris.
# Une sortie sans « error TS » ne prouve rien si tsc n'a pas tourné jusqu'au bout : le 26/11, tsc est mort faute de mémoire
# (tas de 2 Go) sur le nœud lourd, n'a écrit aucune erreur, et ce contrôle a dit OK ; le build de la CI a refusé l'image ensuite.
# Donc : tas élargi, et un tsc qui sort en erreur sans erreur lisible est un ÉCHEC (non abouti : on ne laisse pas passer).
set -u
rc=0
sortie="$(NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=6144" nice -n 19 pnpm -s tsc --noEmit -p . 2>&1)" || rc=$?
erreurs="$(printf '%s\n' "$sortie" | grep -E '^[^ ].*error TS[0-9]+' | grep -v '^e2e/' || true)"
if [ -n "$erreurs" ]; then
  printf '%s\n' "$erreurs" >&2
  echo "typecheck — ÉCHEC : erreurs de type hors e2e/ (le build de la CI les refusera)." >&2
  exit 1
fi
if [ "$rc" -ne 0 ] && ! printf '%s\n' "$sortie" | grep -qE 'error TS[0-9]+'; then
  printf '%s\n' "$sortie" | tail -5 >&2
  echo "typecheck — NON ABOUTI : tsc est sorti en $rc sans aucune erreur lisible (mémoire, crash) : rien n'est prouvé, le push est refusé." >&2
  exit 1
fi
echo "typecheck — OK (hors e2e/, tsc sorti en $rc)."
