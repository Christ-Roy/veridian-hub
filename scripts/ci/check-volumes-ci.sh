#!/usr/bin/env sh
# Chaque volume hôte des jobspecs du Hub (arbre de travail, avant le push) est-il autorisé par la politique ACL de
# la CI ? Le 22/11 (VER-203), le groupe atelier montait hub-atelier : plan et dry-run verts, soumission refusée en
# 403 en prod, faute de règle host_volume. Les règles de lecture viennent du contrôle de l'infra
# (~/nomad-veridian/scripts/contracts/volumes-ci-couverts.py), une seule source.
# Codes : 0 couvert, 1 volume non couvert (demander la règle à l'infra), 0 avec « NON ABOUTI » si l'infra n'est pas
# sur cette machine (runner CI : le contrôle de l'infra le tient à son propre commit).
set -eu
INFRA="${NOMAD_VERIDIAN:-$HOME/nomad-veridian}"
SCRIPT="$INFRA/scripts/contracts/volumes-ci-couverts.py"
POLITIQUE="$INFRA/policies/veridian-ci-deploy.hcl"
if [ ! -f "$SCRIPT" ] || [ ! -f "$POLITIQUE" ]; then
  echo "volumes-ci — NON ABOUTI : $SCRIPT ou la politique introuvable ici, contrôle sauté." >&2
  exit 0
fi
files="${*:-$(find deploy -maxdepth 1 -type f -name '*.nomad.hcl' | sort)}"
exec python3 -I - "$SCRIPT" "$POLITIQUE" $files <<'PY'
import fnmatch, importlib.util, re, sys
script, politique, *fichiers = sys.argv[1:]
spec = importlib.util.spec_from_file_location("volumes_ci", script)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
droits = m.droits_politique(open(politique).read())
manque = []
def couverts(source):
    """Droits accordés à cette source : règle exacte ou motif (hub-atelier-*)."""
    d = set()
    for motif, caps in droits.items():
        if motif == source or fnmatch.fnmatchcase(source, motif):
            d |= caps
    return d

for f in fichiers:
    texte = open(f).read()
    # Groupes générés (dynamic "group" sur local.ateliers) : la source se développe pour chaque tenant de la liste.
    liste = re.search(r'^\s*ateliers\s*=\s*\[([^\]]*)\]', texte, re.M)
    valeurs = re.findall(r'"([^"]+)"', liste.group(1)) if liste else []
    for nom, source_brute, ro in m.volumes_hote(texte):
        sources = [source_brute.replace("${group.value}", v) for v in valeurs] if "${group.value}" in source_brute else [source_brute]
        for source in sources:
          voulu = "mount-readonly" if ro else "mount-readwrite"
          d = couverts(source)
          if voulu not in d and not (ro and "mount-readwrite" in d):
            manque.append(f"{f}: volume « {nom} » (source {source}) exige host_volume \"{source}\" {voulu} dans la politique de la CI")
if manque:
    print("\n".join(manque), file=sys.stderr)
    print("volumes-ci — ÉCHEC : la soumission sera refusée en 403. Demander la règle à l'infra avant de pousser.", file=sys.stderr)
    sys.exit(1)
print(f"volumes-ci — OK : {len(fichiers)} jobspec(s), volumes hôtes couverts par la politique de la CI.")
PY
