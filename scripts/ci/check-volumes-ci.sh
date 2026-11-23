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
import importlib.util, sys
script, politique, *fichiers = sys.argv[1:]
spec = importlib.util.spec_from_file_location("volumes_ci", script)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
droits = m.droits_politique(open(politique).read())
manque = []
for f in fichiers:
    for nom, source, ro in m.volumes_hote(open(f).read()):
        voulu = "mount-readonly" if ro else "mount-readwrite"
        d = droits.get(source, set()) | droits.get("*", set())
        if voulu not in d and not (ro and "mount-readwrite" in d):
            manque.append(f"{f}: volume « {nom} » (source {source}) exige host_volume \"{source}\" {voulu} dans la politique de la CI")
if manque:
    print("\n".join(manque), file=sys.stderr)
    print("volumes-ci — ÉCHEC : la soumission sera refusée en 403. Demander la règle à l'infra avant de pousser.", file=sys.stderr)
    sys.exit(1)
print(f"volumes-ci — OK : {len(fichiers)} jobspec(s), volumes hôtes couverts par la politique de la CI.")
PY
