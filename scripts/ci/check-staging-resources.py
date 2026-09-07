#!/usr/bin/env python3
"""Bloque le retour des réservations staging surdimensionnées."""

from pathlib import Path
import re

JOB = Path("deploy/hub-staging.nomad.hcl")

# Un nom de tache ne se code JAMAIS en dur : Nomad nomme le conteneur d'apres la
# tache, donc les noms bougent quand on les rend auto-porteurs (2026-09-07,
# `pgproxy` -> `hub-staging-pgproxy`, `hub` -> `hub-staging`). Ce controle a
# casse le deploiement staging au premier renommage, avec « task absente:
# pgproxy » — le jobspec etait juste, c'est le controle qui parlait de l'ancien
# monde.
#
# On accepte donc les DEUX noms : le nouveau d'abord, l'ancien en repli. Le
# controle traverse ainsi le renommage sans fenetre rouge, et un futur
# renommage n'a qu'a ajouter un alias ici.
EXPECTED = {
    ("hub-staging-pgproxy", "pgproxy"): (50, 64, 128),
    ("hub-staging", "hub"): (300, 256, 1024),
}


def block(text: str, start: int) -> str:
    opening = text.index("{", start)
    depth = 0
    for pos in range(opening, len(text)):
        if text[pos] == "{":
            depth += 1
        elif text[pos] == "}":
            depth -= 1
            if depth == 0:
                return text[opening + 1 : pos]
    raise AssertionError("bloc HCL non fermé")


text = JOB.read_text(encoding="utf-8")
assert "memory_max = 7000" not in text, "memory_max=7000 interdit en staging"
for noms, expected in EXPECTED.items():
    match = None
    for task in noms:
        match = re.search(rf'task\s+"{re.escape(task)}"\s*\{{', text)
        if match:
            break
    # Aucun des noms acceptes : c'est un vrai defaut, pas un renommage. On nomme
    # les candidats ET les taches reellement presentes, sinon le message envoie
    # chercher au mauvais endroit.
    assert match, (
        f"task absente sous aucun de ses noms {noms} — "
        # Motif ANCRE en debut de ligne : sans ca, la liste ramasse les mentions
        # de `task "..."` dans les COMMENTAIRES d'en-tete et fait croire qu'une
        # tache existe alors qu'elle n'est plus declaree.
        f"taches declarees : {re.findall(r'^\s*task \"([^\"]+)\"', text, re.M)}"
    )
    task_block = block(text, match.start())
    resources = re.search(r"resources\s*\{", task_block)
    assert resources, f"resources absent: {task}"
    resource_block = block(task_block, resources.start())
    actual = tuple(
        int(re.search(rf"\b{name}\s*=\s*(\d+)", resource_block).group(1))
        for name in ("cpu", "memory", "memory_max")
    )
    assert actual == expected, f"{task}: {actual} != {expected}"
    assert actual[2] <= 3072, f"fusible excessif: {task}"

print("OK staging resources hub")
