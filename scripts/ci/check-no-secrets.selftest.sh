#!/usr/bin/env bash
# Non-régression de `check-no-secrets.sh`.
#
# Un contrôle qu'on n'a jamais vu refuser doit être considéré comme non
# fonctionnel. Ce script provoque le cas : il rejoue la forme EXACTE de la
# fuite du 2026-05-21 et exige que le contrôle la refuse.
#
# Il s'exécute dans un dépôt git jetable — il ne touche jamais l'arbre réel.
#
# Exit 0 = le contrôle attrape ce qu'il doit attraper et laisse passer le reste.
set -euo pipefail

CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-no-secrets.sh"
[ -x "$CHECK" ] || { echo "✗ $CHECK introuvable ou non exécutable"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts/ci"
cp "$CHECK" "$TMP/scripts/ci/check-no-secrets.sh"
cd "$TMP"
git init -q . && git config user.email t@t && git config user.name t

fail=0

run_case() {
  local name="$1" expect="$2" # expect = "refuse" | "passe"
  git add -A >/dev/null 2>&1
  set +e
  out=$(./scripts/ci/check-no-secrets.sh 2>&1); rc=$?
  set -e
  if [ "$expect" = "refuse" ] && [ "$rc" -eq 0 ]; then
    echo "✗ $name : le contrôle a LAISSÉ PASSER un secret"; fail=1
  elif [ "$expect" = "passe" ] && [ "$rc" -ne 0 ]; then
    echo "✗ $name : faux positif"; echo "$out" | sed 's/^/    /'; fail=1
  else
    echo "✓ $name (${expect})"
  fi
  rm -f cas.ts cas.env
}

# --- Cas 1 : la fuite réelle du 2026-05-21 ----------------------------------
# Littéral hexadécimal de 64 caractères, sur une ligne SÉPARÉE de
# l'affectation. C'est la forme qui a échappé au contrôle pendant trois mois.
# La valeur ci-dessous est aléatoire et n'a jamais été un secret.
cat > cas.ts <<'EOF'
const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '3f7a1c9e5b2d8046af13e7c25986b4d0173ea9c8542f6b0d9e73a15c8b402f6e';
EOF
run_case "fuite 2026-05-21 (64 hex, ligne séparée)" refuse

# --- Cas 2 : la même valeur dans un fichier d'environnement -----------------
cat > cas.env <<'EOF'
NOTIFUSE_HUB_WEBHOOK_SECRET=3f7a1c9e5b2d8046af13e7c25986b4d0173ea9c8542f6b0d9e73a15c8b402f6e
EOF
run_case "secret dans un .env tracké" refuse

# --- Cas 3 : clé Stripe live (règle motifs fournisseurs) --------------------
# Le vecteur est ASSEMBLÉ à l'exécution : écrit en un seul morceau ici, il
# ferait refuser ce fichier par `check-no-stripe-live-key.sh`, qui a raison.
# Un test de détecteur ne doit pas porter lui-même un motif détectable.
SK_PREFIX='sk_live'
SK_BODY='51QxRtMzKbWnHjPvLcYdFgTsA9e2B7uN4mZ6qX3rV'
printf "const k = '%s_%s';\n" "$SK_PREFIX" "$SK_BODY" > cas.ts
run_case "clé Stripe live" refuse

# --- Cas 4 : fixture factice explicite (ne DOIT PAS être refusée) ----------
cat > cas.ts <<'EOF'
const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  'FAKE-e2e-notifuse-webhook-token-do-not-use-in-prod';
EOF
run_case "fixture factice préfixée FAKE-" passe

# --- Cas 5 : SHA git de 40 caractères (ne DOIT PAS être refusé) ------------
cat > cas.ts <<'EOF'
const pinnedSubmodule = '6b37256a1f4c9d80e2b5137af0c94d6e7a812b30';
EOF
run_case "SHA git 40 hex" passe

# --- Cas 6 : dérogation explicite (ne DOIT PAS être refusée) ---------------
# Vecteur SHA-256 légitime, marqué. La dérogation doit relâcher la ligne
# nommée, et elle seule.
cat > cas.ts <<'EOF'
const sha256OfAbc =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // check-no-secrets:allow
EOF
run_case "ligne portant check-no-secrets:allow" passe

# --- Cas 7 : la dérogation ne déborde pas sur les autres lignes ------------
cat > cas.ts <<'EOF'
const vecteur =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // check-no-secrets:allow
const vraiSecret =
  '3f7a1c9e5b2d8046af13e7c25986b4d0173ea9c8542f6b0d9e73a15c8b402f6e';
EOF
run_case "dérogation limitée à sa ligne" refuse

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "✗ check-no-secrets.sh ne se comporte pas comme attendu — NE PAS le"
  echo "  considérer comme une protection tant que ce test n'est pas vert."
  exit 1
fi
echo ""
echo "✓ check-no-secrets.sh refuse ce qu'il doit refuser et laisse passer le reste"
