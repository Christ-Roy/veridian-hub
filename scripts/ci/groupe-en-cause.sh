#!/usr/bin/env bash
# Lit `nomad job status <job>` sur l'entrée et dit quel groupe du dernier déploiement n'est pas sain, et si le Hub (stack) sert
# la nouvelle version. Un déploiement « failed » avec le correctif servi doit se lire comme tel (24/11 : un atelier en panne
# rougit la CI sans défaire le Hub). Sortie : 0 tout est sain · 1 un groupe est en cause · 2 illisible.
set -uo pipefail
python3 -c '
import re, sys
t = sys.stdin.read()
m = re.search(r"^Latest Deployment\n(.*?)^Allocations", t, re.S | re.M)
if not m: print("::error::déploiement illisible : aucun tableau « Latest Deployment »"); sys.exit(2)
b = m.group(1)
etat = re.search(r"^Status\s+=\s+(.+)$", b, re.M)
lignes = re.split(r"^Deployed\n", b, flags=re.M)
if not etat or len(lignes) != 2: print("::error::déploiement illisible"); sys.exit(2)
corps = [l for l in lignes[1].splitlines() if l.strip()]
cols = re.split(r"\s{2,}", corps[0].strip()); groupes = [dict(zip(cols, re.split(r"\s{2,}", l.strip()))) for l in corps[1:]]
if not groupes or any(not g.get("Healthy", "").isdigit() or not g.get("Desired", "").isdigit() for g in groupes): print("::error::tableau des groupes illisible"); sys.exit(2)
mal = [g for g in groupes if int(g["Healthy"]) < int(g["Desired"])]
st = next((g for g in groupes if g["Task Group"] == "stack"), None)
if st is None: print("::error::groupe stack absent"); sys.exit(2)
servi = int(st["Healthy"]) >= int(st["Desired"]) and st.get("Promoted") == "true"
for g in mal:
    quoi = "placé mais pas sain" if int(g.get("Placed", "0")) else "aucune place trouvée"
    nom, sains, voulus = g["Task Group"], g["Healthy"], g["Desired"]
    print(f"::error::groupe en cause : {nom} ({quoi}, {sains}/{voulus} sain)")
print(f"Déploiement : {etat.group(1).strip()}. Hub (stack) : " + ("NOUVELLE version servie" if servi else "nouvelle version NON servie"))
sys.exit(1 if mal else 0)
'
