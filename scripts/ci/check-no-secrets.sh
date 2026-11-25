#!/usr/bin/env bash
# Refuse tout secret en clair dans un fichier TRACKÉ par git.
#
# Ce dépôt est PUBLIC sur GitHub. Un secret committé ici est publié, et
# l'historique le conserve : la seule remédiation possible est la rotation.
# Ce contrôle est donc fail-closed et bloquant (CI + pre-push Husky).
#
# Deux familles de règles :
#
#   1. MOTIFS FOURNISSEURS — préfixes connus (Stripe, Brevo, Google, Neon,
#      Telegram, URLs Postgres avec mot de passe). Standard maison, aligné sur
#      `yoga-sculpt-app` / `les-vergers-de-faverolles.fr`.
#
#   2. ENTROPIE — la valeur elle-même, indépendamment de sa mise en forme.
#      Cette règle est née de l'incident du 2026-05-21 : trois jetons de
#      webhook de 64 caractères hexadécimaux ont vécu trois mois sur
#      `origin/main` d'un dépôt public. Aucun motif fournisseur ne les a
#      attrapés (un `openssl rand -hex 32` n'a pas de préfixe), et une règle
#      « NOM = valeur » les rate aussi parce que le littéral était sur une
#      ligne SÉPARÉE de l'affectation :
#
#          const NOTIFUSE_WEBHOOK_TOKEN =
#            process.env.NOTIFUSE_WEBHOOK_TOKEN ||
#            '<64 caractères hexadécimaux>';
#
#      Ne pas retirer ni relâcher cette règle sans rejouer le test de
#      non-régression : `scripts/ci/check-no-secrets.selftest.sh`.
#
# DÉROGATION
# -----------
# Une ligne portant le marqueur `check-no-secrets:allow` est ignorée. Réservé
# aux valeurs à forte entropie qui ne sont PAS des secrets : vecteurs de test
# d'une fonction de hachage, empreintes attendues, condensats de référence.
# La dérogation est volontairement explicite et greppable — on relâche une
# ligne nommée, jamais la règle entière :
#
#     git grep -n 'check-no-secrets:allow'
#
# Exit 1 = secret détecté → commit / push / CI refusé.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Un contrôle de sécurité ne doit jamais mourir en silence : sans ce piège, un
# `set -e` déclenché par un grep sans résultat renvoie 1 sans un mot, et
# l'opérateur croit à une détection.
trap 'rc=$?; [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ] && echo "✗ check-no-secrets.sh a échoué (code $rc) — traiter comme un REFUS, pas comme un test vert"; exit $rc' ERR

# --- Règle 1 : motifs fournisseurs -----------------------------------------
PATTERNS='(sk|rk|pk|whsec)_(live|test)_[A-Za-z0-9]{20,}|xkeysib-[A-Za-z0-9]{40,}|GOCSPX-[A-Za-z0-9_-]{20,}|postgres(ql)?://[^:@/ ]+:[^@/ ]{6,}@|AAG[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]{20,}'

# --- Règle 2 : littéral à forte entropie ------------------------------------
# Hexadécimal pur d'au moins 48 caractères : au-dessus des empreintes courantes
# (md5 = 32, sha1 et SHA git = 40) pour ne pas hurler sur un hash légitime, et
# en dessous d'`openssl rand -hex 32` (= 64), la façon dont ces jetons ont été
# générés.
HEX_RE='[0-9a-fA-F]{48,}'
# Base64 d'au moins 40 caractères, alphabet STANDARD uniquement (`+/`).
# Les variantes base64url (`-_`) sont volontairement exclues : leur alphabet
# est celui des slugs et des chemins, et `2026-06-15-SPEC-reconciliation-...`
# passait la règle. Le cas réel à couvrir est hexadécimal, traité au-dessus ;
# on ne sacrifie pas le taux de faux positifs pour une variante théorique.
# Le mélange minuscule + majuscule + chiffre est exigé plus bas.
# Le `/` est EXCLU de l'alphabet : sans ça la règle attrape les URLs et les
# chemins longs (`mailpit/blob/develop/docs/apiv1/README.md`). On perd les
# secrets base64 contenant un `/`, mais le cas réel à couvrir est hexadécimal
# et les mots de passe d'URL sont déjà pris par la règle 1. Un détecteur qui
# refuse des choses saines finit désactivé — c'est le pire des états.
B64_RE='[A-Za-z0-9+]{40,}={0,2}'

# Faux positifs à écarter : placeholders et valeurs manifestement factices.
# `deadbeef` et `0123456789` couvrent les vecteurs de test manifestement
# construits à la main (signatures Stripe bidon, corps de test).
# `\$VAR` / `\${VAR}` / `\$(cmd)` : une interpolation n'est pas une valeur.
# `deadbeef` et `0123456789` : vecteurs de test construits à la main.
BENIGN='CHANGE_ME|x0{6}|1x0{6}|dummy|example|placeholder|localhost|fake|not-real|notreal|whsec_fake|your-|deadbeef|0123456789|\$[A-Za-z_{(]|<[A-Za-z_-]+>|\.\.\.'

# Hors périmètre : ce script et son autotest (ils contiennent les motifs), les
# .example (placeholders par vocation), les lockfiles, la doc, et les
# instantanés forensiques déjà archivés.
EXCLUDE='^scripts/ci/check-no-secrets(\.selftest)?\.sh$|\.example|\.md$|package-lock\.json|pnpm-lock\.yaml|^runbooks/services/hub/forensique-'

# Une seule passe, un seul processus (25/11/2026) : plusieurs grep par fichier suivi coûtaient 1 min 45 sur le bastion chargé, et
# un push trop lent finit contourné. Mêmes règles, même périmètre : tout ce que git suit. Les noms sont lus bruts (-z) : avant,
# git rendait un nom accentué entre guillemets et le fichier n'était jamais ouvert, en CI comme au push.
# Un fichier illisible arrête le contrôle (code 2), il ne passe jamais pour sain.
export PATTERNS HEX_RE B64_RE BENIGN EXCLUDE
hits=$(git ls-files -z | python3 -I -c '
import os, re, sys
env = os.environ
motifs, benin, exclu = re.compile(env["PATTERNS"]), re.compile(env["BENIGN"], re.I), re.compile(env["EXCLUDE"])
hexa, b64 = re.compile(env["HEX_RE"]), re.compile(env["B64_RE"])
hex_pur, digest = re.compile(r"[0-9a-fA-F]{48,}\Z"), re.compile(r"@sha256:[0-9a-f]{64}")

def jetons(ligne):
    # Comme `grep -oE "HEX|B64"` : le plus à gauche, puis le plus long des deux.
    i = 0
    while True:
        m, n = hexa.search(ligne, i), b64.search(ligne, i)
        if not m and not n:
            return
        c = [x for x in (m, n) if x]
        d = min(x.start() for x in c)
        x = max((x for x in c if x.start() == d), key=lambda x: x.end())
        yield x.group()
        i = x.end()

lus = 0
for nom in sys.stdin.buffer.read().split(b"\0"):
    if not nom or exclu.search(nom.decode("utf-8", "surrogateescape")) or not os.path.isfile(nom):
        continue
    with open(nom, "rb") as f:
        brut = f.read()
    lus += 1
    if b"\0" in brut:          # binaire, comme grep -I
        continue
    mauvaises = []
    for n, ligne in enumerate(brut.decode("latin-1").split("\n"), 1):
        if "check-no-secrets:allow" in ligne:
            continue
        pris = bool(motifs.search(ligne)) and not benin.search(ligne)
        if not pris:
            for j in jetons(ligne):
                if benin.search(j):
                    continue
                if not hex_pur.match(j) and not all(re.search(x, j) for x in ("[a-z]", "[A-Z]", "[0-9]")):
                    continue
                if not digest.search(ligne):
                    pris = True
                    break
        if pris:
            mauvaises.append(n)
    if mauvaises:
        # Le fichier et la ligne, JAMAIS la valeur : cette sortie peut finir dans un log de CI public.
        sys.stdout.buffer.write(b"  " + nom + b" (lignes " + ",".join(map(str, mauvaises)).encode() + b")\n")
if not lus:
    sys.exit("aucun fichier lu")
') || { echo "✗ check-no-secrets.sh n'a pas abouti : à traiter comme un REFUS"; exit 2; }

if [ -n "$hits" ]; then
  echo "✗ SECRET en clair détecté dans un fichier tracké :"
  printf '%s\n' "$hits"
  echo ""
  echo "  Ce dépôt est PUBLIC. Committer ce fichier publie la valeur, et"
  echo "  l'historique la conserve : il faudrait ROTATIONNER le secret."
  echo ""
  echo "  → Sors la valeur du dépôt : secret GitHub Actions pour la CI,"
  echo "    variable Nomad pour le runtime, ~/credentials/.all-creds.env pour toi."
  echo "  → Dans un test, mets un littéral manifestement factice (préfixe FAKE-)"
  echo "    et lis la vraie valeur depuis process.env."
  exit 1
fi
echo "✓ Aucun secret en clair dans les fichiers trackés"
