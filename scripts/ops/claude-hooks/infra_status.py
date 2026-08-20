#!/usr/bin/env python3
"""infra-status — le bloc « INFRA STATUS » injecté au SessionStart de Claude Code.

────────────────────────────────────────────────────────────────────────────────
LE PRINCIPE QUI GOUVERNE TOUT CE FICHIER

Rien de la flotte n'est écrit ici. Aucune machine, aucune adresse IP, aucun
« X tourne sur Y ». Tout se découvre à l'exécution :

  · les nœuds            → API Nomad (/v1/nodes), jamais une liste
  · leurs adresses       → attribut `unique.network.ip-address` (IP publique)
                           et champ `Address` (tailnet) du nœud lui-même
  · les alias SSH        → ~/.ssh/config, rapprochés du nœud par son IP
  · les instances Traefik→ allocations Nomad des jobs qui portent l'ingress
  · les dépôts SaaS      → contenu du disque, pas une constante

Un nœud ajouté demain apparaît sans qu'on touche à ce code. C'est tout l'objet
du fichier : la version précédente énumérait trois machines et en ignorait deux,
dont celle qui portait l'ingress public. Le bloc de contexte décrivait alors une
infrastructure qui n'existait plus — et une fausseté dans le contexte est pire
qu'un manque, parce qu'elle inspire confiance.

────────────────────────────────────────────────────────────────────────────────
LA RÈGLE QUI COMPTE LE PLUS : PAS DE MESURE ≠ PAS DE PROBLÈME

Toute cible attendue qui ne rend pas de mesure ressort INDÉTERMINÉ avec son
motif. Jamais absente. Jamais saine. Quatre outils de la maison se sont fait
avoir en lisant « pas de mesure » comme « tout va bien » ; ici le rendu est
construit à partir de l'INVENTAIRE ATTENDU (les nœuds que Nomad déclare), et
chaque ligne de l'inventaire est rendue, mesurée ou non.

────────────────────────────────────────────────────────────────────────────────
BUDGET DE TEMPS ET COÛT SUR LES DISQUES

Le hook tourne à chaque démarrage de session : il ne doit jamais bloquer. Un
budget global (INFRA_STATUS_BUDGET, 30 s par défaut) est réparti entre les
phases ; ce qui n'a pas répondu dans son délai devient INDÉTERMINÉ au lieu
d'être attendu.

Aucune collecte n'ouvre de session SSH sur les nœuds et aucune ne balaie un
système de fichiers distant. Les ressources machine viennent de l'agent Nomad
qui tourne déjà sur chaque nœud (/v1/client/stats) : c'est une lecture de
/proc côté agent, sans I/O disque supplémentaire. C'est délibéré — plusieurs
nœuds ont une latence d'fsync dégradée, et une sonde qui les martèle à chaque
session aggraverait ce qu'elle prétend surveiller.

────────────────────────────────────────────────────────────────────────────────
CE QUE CE FICHIER NE FAIT PAS

Il ne mesure rien lui-même quand un outil de la maison le fait déjà. Il
consomme `secu` (vulnérabilités), `obs check` (topiques d'observabilité) et
l'API Nomad. Toute nouvelle mesure a sa place dans un outil réutilisable
(~/all-cron/observability/), pas ici.

Pour modifier : `python3 infra_status.py` depuis n'importe quel dossier, et
depuis un dépôt SaaS pour voir la section « dépôt courant ».
"""

from __future__ import annotations

import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
SAAS_ROOT = os.environ.get("VERIDIAN_SAAS_ROOT", f"{HOME}/Bureau/veridian-platform")
NOMAD_ENV = os.environ.get("INFRA_STATUS_NOMAD_ENV",
                          f"{HOME}/credentials/nomad-bastion.env")
SSH_CONFIG = os.environ.get("INFRA_STATUS_SSH_CONFIG", f"{HOME}/.ssh/config")

BUDGET = float(os.environ.get("INFRA_STATUS_BUDGET", "30"))
DEBUT = time.monotonic()

# Le dry-run réel du pre-push exécute la suite de tests du dépôt courant. C'est
# une information précieuse mais elle coûte du CPU sur le poste à CHAQUE
# ouverture de session, sur une machine déjà chargée. Elle est donc explicite.
DRYRUN = os.environ.get("INFRA_STATUS_DRYRUN") == "1"

IND = "INDÉTERMINÉ"


# ── Socle ───────────────────────────────────────────────────────────────────
def restant(marge: float = 0.5) -> float:
    """Secondes encore disponibles dans le budget global."""
    return max(0.0, BUDGET - (time.monotonic() - DEBUT) - marge)


def sh(cmd: list[str] | str, timeout: float) -> tuple[int, str]:
    """Exécute une commande. Rend (code, sortie) ; code 124 = dépassement."""
    if timeout <= 0:
        return 124, ""
    try:
        p = subprocess.run(
            cmd, shell=isinstance(cmd, str), capture_output=True, text=True,
            timeout=timeout, errors="replace",
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, ""
    except OSError as e:
        return 127, str(e)


def http_json(url: str, headers: dict | None = None, timeout: float = 6.0):
    """GET JSON. Rend (données, None) ou (None, motif lisible)."""
    if timeout <= 0:
        return None, "budget de temps épuisé avant l'appel"
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code} sur {url.split('/v1/')[-1] or url}"
    except urllib.error.URLError as e:
        return None, f"injoignable ({getattr(e, 'reason', e)})"
    except TimeoutError:
        return None, f"pas de réponse en {timeout:.0f}s"
    except Exception as e:  # noqa: BLE001 — un hook ne casse jamais la session
        return None, f"{type(e).__name__}: {e}"


def go(v: float, seuil_warn: float, seuil_crit: float, inverse: bool = False) -> str:
    """Glyphe de gravité pour une valeur numérique."""
    if inverse:  # plus c'est bas, plus c'est grave (RAM disponible, CPU idle)
        return "🚨" if v < seuil_crit else ("⚠" if v < seuil_warn else "✓")
    return "🚨" if v > seuil_crit else ("⚠" if v > seuil_warn else "✓")


# ── Accès Nomad ─────────────────────────────────────────────────────────────
def nomad_acces() -> tuple[str | None, dict, str | None]:
    """Adresse et en-têtes Nomad, lus depuis le fichier de credentials.

    Le fichier ne porte pas forcément NOMAD_TOKEN : sur ce poste il définit
    NOMAD_MGMT_TOKEN. Sans jeton l'API répond 403 et la sonde rendrait un
    « tout va bien » mensonger, d'où les variantes essayées et le motif
    explicite quand aucune ne convient.
    """
    env: dict[str, str] = {}
    if os.path.exists(NOMAD_ENV):
        for ligne in open(NOMAD_ENV, encoding="utf-8", errors="replace"):
            ligne = ligne.strip()
            if ligne.startswith("export "):
                ligne = ligne[7:]
            if "=" in ligne and not ligne.startswith("#"):
                k, _, v = ligne.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    addr = env.get("NOMAD_ADDR") or os.environ.get("NOMAD_ADDR")
    if not addr:
        return None, {}, f"NOMAD_ADDR introuvable ({NOMAD_ENV})"
    jeton = (env.get("NOMAD_TOKEN") or env.get("NOMAD_MGMT_TOKEN")
             or env.get("NOMAD_UI_TOKEN") or os.environ.get("NOMAD_TOKEN"))
    if not jeton:
        return addr, {}, "aucun jeton Nomad utilisable — mesures partielles"
    return addr, {"X-Nomad-Token": jeton}, None


# ── Alias SSH : lus dans la config, rapprochés du nœud par son IP ───────────
def alias_ssh() -> list[tuple[list[str], str]]:
    """[(aliases, hostname), …] tels que déclarés dans ~/.ssh/config."""
    blocs: list[tuple[list[str], str]] = []
    noms: list[str] = []
    if not os.path.exists(SSH_CONFIG):
        return blocs
    for ligne in open(SSH_CONFIG, encoding="utf-8", errors="replace"):
        m = re.match(r"^\s*Host\s+(.+?)\s*$", ligne, re.I)
        if m:
            noms = [a for a in m.group(1).split() if "*" not in a and "?" not in a]
            continue
        m = re.match(r"^\s*Host[Nn]ame\s+(\S+)", ligne, re.I)
        if m and noms:
            blocs.append((noms, m.group(1)))
            noms = []
    return blocs


def alias_pour(ips: set[str], nom_noeud: str, blocs) -> str:
    """Alias SSH utilisable pour un nœud, découvert par correspondance d'IP.

    Priorité à l'alias qui pointe vers l'IP publique : les alias tailnet
    échouent quand Tailscale dort, ce qui donne un « injoignable » qui ne dit
    rien de la machine. Un alias homonyme du nœud est retenu à défaut.
    """
    publics, tailnet = [], []
    for noms, hote in blocs:
        if hote not in ips:
            continue
        (tailnet if hote.startswith("100.") else publics).append(noms[0])
    if publics:
        return publics[0]
    if tailnet:
        return tailnet[0]
    homonymes = [n for noms, _ in blocs for n in noms if n == nom_noeud]
    if homonymes:
        return homonymes[0]
    if nom_noeud == os.uname().nodename.split(".")[0]:
        return "local"
    return f"{IND} : aucun alias"


# ── §1 — La flotte ──────────────────────────────────────────────────────────
def section_flotte(addr, hdrs, err) -> list[str]:
    out = ["## FLOTTE — nœuds découverts via l'API Nomad"]
    if err and not addr:
        out.append(f"  🚨 {IND} — inventaire des nœuds impossible : {err}")
        out.append("     → sans inventaire, AUCUNE conclusion sur la flotte n'est valide.")
        return out
    if err:
        out.append(f"  ⚠ {err}")

    noeuds, motif = http_json(f"{addr}/v1/nodes", hdrs, min(6.0, restant()))
    if noeuds is None:
        out.append(f"  🚨 {IND} — liste des nœuds inaccessible : {motif}")
        out.append("     → ne rien conclure de l'absence d'alerte ci-dessous.")
        return out

    blocs = alias_ssh()
    attendus = sorted(noeuds, key=lambda n: n.get("Name", ""))

    def detail(n: dict) -> dict:
        nid = n.get("ID", "")
        fiche, m1 = http_json(f"{addr}/v1/node/{nid}", hdrs, min(5.0, restant()))
        stats, m2 = http_json(f"{addr}/v1/client/stats?node_id={nid}", hdrs,
                              min(5.0, restant()))
        return {"noeud": n, "fiche": fiche, "stats": stats,
                "motif": m2 or m1 or ""}

    lignes, alertes = [], []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        resultats = list(ex.map(detail, attendus))

    largeur = max((len(n.get("Name", "?")) for n in attendus), default=10)
    lc = max((len(((r["fiche"] or {}).get("Meta") or {}).get("classe")
                  or ((r["fiche"] or {}).get("Meta") or {}).get("provider") or "—")
              for r in resultats), default=8)
    for r in resultats:
        n, fiche, stats = r["noeud"], r["fiche"], r["stats"]
        nom = n.get("Name", "?")
        statut = n.get("Status", "?")
        elig = n.get("SchedulingEligibility", "?")
        drain = bool(n.get("Drain"))

        meta = (fiche or {}).get("Meta") or {}
        attrs = (fiche or {}).get("Attributes") or {}
        ip_pub = attrs.get("unique.network.ip-address", "")
        ips = {x for x in (ip_pub, n.get("Address", "")) if x}
        via = alias_pour(ips, nom, blocs)
        classe = meta.get("classe") or meta.get("provider") or "—"

        # L'état déclaré par le serveur prime : un nœud « down » est une panne,
        # pas une absence de mesure.
        if statut != "ready":
            alertes.append(f"🚨 {nom} : nœud en statut « {statut} » — ses allocations "
                           f"sont perdues ou vont l'être")
        elif drain or elig != "eligible":
            alertes.append(f"⚠ {nom} : {'drain actif' if drain else 'inéligible'} — "
                           f"rien de neuf ne s'y placera")

        if not stats:
            lignes.append(f"  ⁉ {nom:<{largeur}}  {classe:<{lc}} {statut:<7} "
                          f"{IND} — {r['motif'] or 'agent muet'}   (ssh: {via})")
            alertes.append(f"⁉ {nom} : {IND} — l'agent ne rend pas ses ressources "
                           f"({r['motif'] or 'sans motif'}). Ni sain ni malade : à vérifier.")
            continue

        mem = stats.get("Memory") or {}
        total = mem.get("Total") or 0
        dispo = mem.get("Available") or (total - (mem.get("Used") or 0))
        dispo_mo = dispo / 2**20
        ram_txt = f"{(total - dispo)/2**30:.1f}/{total/2**30:.1f}G" if total else "?"

        racine = next((d for d in (stats.get("DiskStats") or [])
                       if d.get("Mountpoint") == "/"), None)
        disque_pct = racine.get("UsedPercent") if racine else None
        libre_go = (racine.get("Available", 0) / 2**30) if racine else 0

        cpus = stats.get("CPU") or []
        idle = sum(c.get("Idle", 0) for c in cpus) / len(cpus) if cpus else None

        g_ram = go(dispo_mo, 1024, 512, inverse=True)
        g_disq = go(disque_pct, 80, 90) if disque_pct is not None else "⁉"
        g_cpu = go(idle, 20, 10, inverse=True) if idle is not None else "⁉"
        pire = "🚨" if "🚨" in (g_ram + g_disq + g_cpu) else (
            "⚠" if "⚠" in (g_ram + g_disq + g_cpu) else "✓")

        lignes.append(
            f"  {pire} {nom:<{largeur}}  {classe:<{lc}} {statut:<7} "
            f"RAM {ram_txt} {g_ram}  "
            f"disque {disque_pct:.0f}% ({libre_go:.0f}G libres) {g_disq}  "
            f"cpu idle {idle:.0f}% {g_cpu}   (ssh: {via})"
            if disque_pct is not None and idle is not None else
            f"  {pire} {nom:<{largeur}}  {classe:<{lc}} {statut:<7} RAM {ram_txt} {g_ram}"
            f"   (ssh: {via})")

        if g_ram == "🚨":
            alertes.append(f"🚨 {nom} : {dispo_mo:.0f} Mo de RAM disponible — plus de "
                           f"page cache, les bases se dégradent avant l'OOM")
        elif g_ram == "⚠":
            alertes.append(f"⚠ {nom} : {dispo_mo:.0f} Mo de RAM disponible")
        if g_disq == "🚨":
            alertes.append(f"🚨 {nom} : disque à {disque_pct:.0f}% ({libre_go:.0f} Go "
                           f"libres) — un log qui s'emballe fige le nœud")
        elif g_disq == "⚠":
            alertes.append(f"⚠ {nom} : disque à {disque_pct:.0f}% ({libre_go:.0f} Go libres)")
        # Sur un poste de travail, une charge élevée est le fonctionnement
        # normal : du développement y tourne. La signaler comme une panne
        # apprend à ignorer la ligne. On la dit, sans l'escalader.
        if g_cpu == "🚨" and classe == "poste-travail":
            alertes.append(f"· {nom} : {idle:.0f}% de CPU inoccupé — attendu sur un "
                           f"poste de travail, à ne pas traiter comme une panne")
        elif g_cpu == "🚨":
            alertes.append(f"🚨 {nom} : {idle:.0f}% de CPU inoccupé — à ce niveau "
                           f"l'agent Nomad rate ses heartbeats et le nœud peut être "
                           f"déclaré mort à tort")

    out += lignes
    mesures = sum(1 for r in resultats if r["stats"])
    out.append(f"  ── couverture : {mesures}/{len(attendus)} nœuds mesurés"
               + ("" if mesures == len(attendus) else f" · {len(attendus)-mesures} {IND}"))
    if alertes:
        out.append("")
        out += [f"  {a}" for a in alertes]
    return out


# ── §2 — Ce qui tourne ──────────────────────────────────────────────────────
def endormissable(job_id: str) -> bool:
    """Ce job est-il légitimement à zéro allocation ?

    Sablier met le staging et les démos à l'arrêt tant que personne ne les
    consulte : statut `dead`, zéro allocation. C'est le scale-to-zero attendu,
    pas une panne. Sans cette exclusion, une quinzaine de fausses pannes
    remontent à chaque session et on apprend à ne plus lire le bloc.
    """
    return any(m in (job_id or "") for m in ("-staging", "-medusa", "demo"))


def section_jobs(addr, hdrs) -> list[str]:
    out = ["## SERVICES — jobs Nomad (silence = tout tourne)"]
    if not addr:
        out.append(f"  ⁉ {IND} — pas d'accès Nomad")
        return out
    jobs, motif = http_json(f"{addr}/v1/jobs", hdrs, min(6.0, restant()))
    if jobs is None:
        out.append(f"  ⁉ {IND} — liste des jobs inaccessible : {motif}")
        return out

    vivants, morts, endormis = 0, [], 0
    for j in jobs:
        if j.get("Type") in ("batch",) and "/periodic-" in (j.get("ID") or ""):
            continue  # instances d'un périodique : bruit pur
        if j.get("Stop"):
            continue
        somme = j.get("JobSummary", {}).get("Summary", {}) or {}
        # « Starting » compte comme vivant : sans cela, un job en cours de
        # redémarrage ressort en panne pendant quelques secondes, et une alerte
        # qui clignote au hasard des sessions ne vaut rien.
        run = sum(v.get("Running", 0) + v.get("Starting", 0) for v in somme.values())
        jid = j.get("ID", "?")
        # Le compteur `Failed` du résumé est CUMULATIF depuis la soumission du
        # job : il vaut 12 sur un job sain redéployé douze fois. Le remonter
        # produisait dix-sept lignes ⚠ permanentes — et une section toujours
        # jaune apprend à ne plus lire le bloc. Seul l'état présent compte ici ;
        # l'historique des échecs se lit avec `nomad-v allocs <job>`.
        if run > 0:
            vivants += 1
            continue
        if endormissable(jid):
            endormis += 1
            continue
        if j.get("Type") in ("batch", "sysbatch") or j.get("Periodic"):
            continue  # un batch au repos est au repos
        morts.append(f"🚨 {jid} : aucune allocation en marche "
                     f"(job déclaré « {j.get('Status')} »)")

    out.append(f"  {vivants} jobs en marche · {endormis} endormis (sablier, normal)"
               f" · {len(morts)} à regarder")
    out += [f"  {m}" for m in sorted(morts)]
    if not morts:
        out.append("  ✓ aucun service attendu à l'arrêt")
    out.append("  → détail par tier : `nomad-v tiers` · dashboard live : `nomad-v state`")
    return out


# ── §3 — Ingress : instances découvertes, pas nommées ───────────────────────
def instances_ingress(addr, hdrs) -> tuple[list[dict], str | None]:
    """Toute allocation en marche dont la tâche est un Traefik, où qu'elle soit.

    On part des allocations et non d'un nom de job : un ingress renommé,
    dédoublé ou déplacé reste vu. L'API Traefik écoute en clair sur le port
    déclaré dans la config du job (entryPoint d'administration), joignable par
    l'adresse tailnet du nœud qui porte l'allocation.
    """
    allocs, motif = http_json(f"{addr}/v1/allocations?task_states=false", hdrs,
                              min(6.0, restant()))
    if allocs is None:
        return [], f"allocations Nomad illisibles : {motif}"
    if not allocs:
        return [], "Nomad ne rend aucune allocation"
    noeuds, _ = http_json(f"{addr}/v1/nodes", hdrs, min(4.0, restant()))
    adresse = {n["ID"]: n.get("Address") for n in (noeuds or [])}
    vus, res = set(), []
    for a in allocs:
        if a.get("ClientStatus") != "running":
            continue
        jid = a.get("JobID", "")
        if "ingress" not in jid and "traefik" not in jid:
            continue
        cle = (jid, a.get("NodeName"))
        if cle in vus:
            continue
        vus.add(cle)
        res.append({"job": jid, "noeud": a.get("NodeName", "?"),
                    "ip": adresse.get(a.get("NodeID"), "")})
    return res, None


def section_ingress(addr, hdrs) -> list[str]:
    out = ["## INGRESS — instances Traefik découvertes par leurs allocations"]
    if not addr:
        out.append(f"  ⁉ {IND} — pas d'accès Nomad")
        return out
    insts, motif = instances_ingress(addr, hdrs)
    if motif:
        out.append(f"  ⁉ {IND} — {motif}. L'état de l'ingress reste inconnu : "
                   f"ne pas le lire comme « tout passe ».")
        return out
    if not insts:
        out.append(f"  🚨 {IND} — aucune allocation d'ingress parmi celles que Nomad "
                   f"rend. Soit le trafic public n'est plus servi, soit la découverte "
                   f"est cassée : les deux méritent vérification (`nomad-v tiers`).")
        return out

    # Le port d'administration est déclaré dans la config du job, pas ici.
    ports = sorted({p for p in (portes_admin(addr, hdrs, insts) or [8081])})

    def sonde(i: dict) -> dict:
        if not i["ip"]:
            return {**i, "motif": "adresse tailnet du nœud inconnue"}
        dernier = "aucun port d'administration n'a répondu"
        for port in ports:
            d, motif = http_json(f"http://{i['ip']}:{port}/api/http/routers", None,
                                 min(4.0, restant()))
            if d is not None:
                actifs = [r for r in d if r.get("status") == "enabled"]
                casses = [r.get("name", "?") for r in d if r.get("status") != "enabled"]
                return {**i, "total": len(d), "actifs": len(actifs), "casses": casses}
            dernier = motif
        return {**i, "motif": dernier}

    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        res = list(ex.map(sonde, insts))

    couverts = [r for r in res if "total" in r]
    for r in sorted(res, key=lambda x: x["job"]):
        if "total" not in r:
            out.append(f"  ⁉ {r['job']:<14} sur {r['noeud']:<17} {IND} — {r['motif']}")
            continue
        g = "✓" if not r["casses"] else "⚠"
        out.append(f"  {g} {r['job']:<14} sur {r['noeud']:<17} "
                   f"{r['actifs']}/{r['total']} routers actifs"
                   + (f" · en défaut : {', '.join(r['casses'][:4])}" if r["casses"] else ""))

    if len(couverts) >= 2:
        maxi = max(c["total"] for c in couverts)
        for c in couverts:
            manque = maxi - c["total"]
            if manque > 0:
                out.append(f"  ⚠ {c['job']} porte {manque} routers de moins que la plus "
                           f"complète — il ne pourrait pas prendre le relais en l'état")
    elif len(couverts) == 1:
        out.append("  ⚠ une seule instance d'ingress mesurée : pas de comparaison "
                   "possible, et pas de relais si elle tombe")
    manquants = len(res) - len(couverts)
    out.append(f"  ── couverture : {len(couverts)}/{len(res)} instances interrogées"
               + ("" if not manquants else f" · {manquants} {IND}"))
    return out


def portes_admin(addr, hdrs, insts) -> list[int]:
    """Ports d'administration Traefik, lus dans la config des jobs d'ingress."""
    ports: set[int] = set()
    for jid in {i["job"] for i in insts}:
        spec, _ = http_json(f"{addr}/v1/job/{jid}", hdrs, min(4.0, restant()))
        if not spec:
            continue
        brut = json.dumps(spec)
        # entryPoints d'administration : « address: ":8081" » dans le YAML embarqué
        for m in re.finditer(r'address:\s*\\?"?:(\d{2,5})', brut):
            p = int(m.group(1))
            if p not in (80, 443):
                ports.add(p)
    return sorted(ports)


# ── §4 — Sécurité et observabilité : on consomme, on ne remesure pas ────────
def lance_fond(cmd: list[str] | str, timeout: float):
    try:
        return subprocess.Popen(cmd, shell=isinstance(cmd, str), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                errors="replace")
    except OSError:
        return None


def recolte(proc, timeout: float, quoi: str, indice: str) -> list[str]:
    if proc is None:
        return [f"  ⁉ {quoi} : {IND} — outil introuvable. {indice}"]
    try:
        sortie, _ = proc.communicate(timeout=max(0.5, timeout))
    except subprocess.TimeoutExpired:
        proc.kill()
        return [f"  ⁉ {quoi} : {IND} — pas de réponse dans le budget "
                f"({timeout:.0f}s). {indice}"]
    lignes = [l.rstrip() for l in (sortie or "").splitlines() if l.strip()]
    if not lignes:
        return [f"  ⁉ {quoi} : {IND} — sortie vide. {indice}"]
    return [f"  {l}" for l in lignes]


# ── Capacité, sauvegardes, fusibles : on consomme les outils existants ──────
def extrait_section(texte: str, debut: str, fin: str) -> list[str]:
    """Découpe une section du tableau de bord `nomad-v state` par ses titres."""
    lignes, dedans, res = (texte or "").splitlines(), False, []
    for l in lignes:
        if l.startswith(debut):
            dedans = True
            continue
        if dedans and l.startswith(fin):
            break
        if dedans and l.strip():
            res.append(l.rstrip())
    return res


def section_capacite() -> list[str]:
    """Réservé par le scheduler contre réellement consommé.

    Les deux divergent énormément : un nœud peut être SATURÉ en réservation
    déclarée tout en tournant à 90 % de CPU inoccupé. Décider sans les deux,
    c'est soit refuser un déploiement sur une machine vide, soit en écrouler
    une qui paraissait libre. L'usage réel est dans la section FLOTTE ; ici
    c'est le côté réservation.
    """
    out = ["## CAPACITÉ — réservé par le scheduler (`nomad-v free`)"]
    code, sortie = sh(["nomad-v", "free"], min(12.0, restant()))
    if code == 124:
        out.append(f"  ⁉ {IND} — `nomad-v free` n'a pas répondu dans le budget")
        return out
    if code != 0:
        out.append(f"  ⁉ {IND} — `nomad-v free` a échoué (code {code})")
        return out
    corps = [l.rstrip() for l in sortie.splitlines()[1:]
             if l.strip() and not l.startswith(("Lecture", "Nomad refuse"))]
    utiles = [l for l in corps if "?" not in l or "NŒUD" in l]
    # Une section entièrement remplie de « ? » n'informe de rien mais donne
    # l'illusion d'une mesure : on le dit au lieu de l'afficher.
    if len(utiles) <= 2:
        out.append(f"  ⁉ {IND} — `nomad-v free` rend « ? » sur toutes les colonnes : "
                   f"la réservation n'est pas mesurée en ce moment, ne pas conclure "
                   f"qu'il reste de la place.")
        return out
    out += [f"  {l}" for l in corps]
    return out


def section_backups(etat: str) -> list[str]:
    """Preuve de sauvegarde : l'instantané cross-nœud, et la copie froide R2.

    La rétention est comptée sur les préfixes réellement présents dans le
    bucket, pas sur une liste de bases écrite ici : une base ajoutée demain
    doit apparaître sans qu'on touche au code, et une base qui disparaît du
    bucket doit se voir.
    """
    out = ["## SAUVEGARDES — instantané cross-nœud et copie froide"]
    lignes = extrait_section(etat, "▓▓ BACKUPS", "▓▓ BACKLOG") if etat else []
    if lignes:
        out += [f"  {l.strip()}" for l in lignes]
    else:
        out.append(f"  ⁉ {IND} — `nomad-v state` n'a pas rendu sa section BACKUPS")

    code, sortie = sh(["rclone", "lsd", "r2:veridian-backups"], min(10.0, restant()))
    if code != 0:
        out.append(f"  ⁉ copie froide R2 : {IND} — rclone a échoué (code {code})")
        return out
    prefixes = [l.split()[-1] for l in sortie.splitlines() if l.strip()]
    if not prefixes:
        out.append("  🚨 copie froide R2 : le bucket ne contient aucun préfixe — "
                   "il n'y a plus de copie hors-site du tout")
        return out
    out.append(f"  copie froide R2 : {len(prefixes)} bases sauvegardées "
               f"(détail : `rclone lsd r2:veridian-backups`)")
    return out


def section_fusibles() -> list[str]:
    """Coupures volontaires posées à la main.

    Un fusible posé à la main est invisible tant qu'on ne va pas le chercher :
    s'il traîne, on croit que l'intégration est cassée alors qu'elle est en
    pause. Silence total quand il n'y en a aucun.
    """
    import glob as _glob
    flags = sorted(_glob.glob(f"{HOME}/credentials/social/*-EN-PAUSE"))
    if not flags:
        return []
    out = ["## 🔴 FUSIBLES POSÉS — coupures volontaires en cours"]
    for f in flags:
        nom = os.path.basename(f).replace("-EN-PAUSE", "")
        depuis = datetime.fromtimestamp(os.path.getmtime(f)).strftime("%Y-%m-%d %H:%M")
        out.append(f"  ⛔ {nom} — depuis {depuis}")
        try:
            motif = open(f, encoding="utf-8", errors="replace").read().splitlines()[2:6]
            out += [f"     {l.strip()}" for l in motif if l.strip()]
        except OSError:
            pass
        out.append(f"     lever le fusible : rm {f}")
    return out


# ── §5 — Dépôts SaaS : découverts sur le disque ─────────────────────────────
def depots() -> list[str]:
    if not os.path.isdir(SAAS_ROOT):
        return []
    return sorted(d for d in os.listdir(SAAS_ROOT)
                  if os.path.isdir(os.path.join(SAAS_ROOT, d, ".git")))


def git(d: str, *args: str, timeout: float = 5.0) -> str:
    code, out = sh(["git", "-C", d, *args], timeout)
    return out.strip() if code == 0 else ""


def image_deployee(addr, hdrs, depot: str, jobs_images: dict) -> str:
    """Image réellement déployée pour ce dépôt, trouvée par correspondance.

    Le rapprochement se fait sur le chemin de l'image GHCR, pas sur une table
    dépôt→conteneur : la version précédente en tenait une, écrite du temps de
    Dokploy, et elle rendait « n/a » sur toute la ligne depuis la migration.
    """
    jeton = depot.replace("veridian-", "").replace("-repo", "").replace("-veridian", "")
    if not jeton:
        return ""
    trouves = []
    for job, images in jobs_images.items():
        for img in images:
            chemin = img.split("@")[0]
            nom = chemin.rsplit("/", 1)[-1].split(":")[0]
            if jeton and (jeton in nom or nom in depot):
                trouves.append((job, chemin.rsplit("/", 1)[-1]))
    if not trouves:
        return ""
    return " · ".join(f"{j}: {t}" for j, t in sorted(trouves)[:3])


def images_des_jobs(addr, hdrs) -> dict:
    """{job: [images]} pour les jobs applicatifs en marche."""
    jobs, _ = http_json(f"{addr}/v1/jobs", hdrs, min(5.0, restant()))
    if not jobs:
        return {}
    cibles = [j["ID"] for j in jobs
              if j.get("Status") == "running" and "/periodic-" not in j["ID"]]

    def une(jid):
        spec, _ = http_json(f"{addr}/v1/job/{jid}", hdrs, min(4.0, restant()))
        if not spec:
            return jid, []
        return jid, [t.get("Config", {}).get("image", "")
                     for g in spec.get("TaskGroups") or []
                     for t in g.get("Tasks") or []
                     if "christ-roy" in (t.get("Config", {}).get("image") or "")]

    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        return {j: i for j, i in ex.map(une, cibles) if i}


def ligne_depot(d: str, jobs_images: dict, addr, hdrs) -> str:
    chemin = os.path.join(SAAS_ROOT, d)
    branche = git(chemin, "rev-parse", "--abbrev-ref", "HEAD") or "?"
    sale = len([l for l in git(chemin, "status", "--porcelain").splitlines() if l])
    bits = []

    a_stg = git(chemin, "rev-parse", "--verify", "origin/staging")
    a_main = git(chemin, "rev-parse", "--verify", "origin/main")
    if a_stg and a_main:
        av = git(chemin, "rev-list", "--count", "origin/main..origin/staging") or "0"
        ar = git(chemin, "rev-list", "--count", "origin/staging..origin/main") or "0"
        if av != "0" and ar != "0":
            bits.append(f"stg↕main ↑{av}↓{ar}⚠")
        elif ar != "0":
            bits.append(f"main↑{ar} ⚠hotfix")
        elif av != "0":
            bits.append(f"stg→main:{av}")

    if sale:
        bits.append(f"dirty:{sale}")
    todo = os.path.join(chemin, "todo")
    if os.path.isdir(todo):
        n = len([f for f in os.listdir(todo) if f.endswith(".md")])
        if n:
            bits.append(f"todo:{n}")
    img = image_deployee(addr, hdrs, d, jobs_images) if jobs_images else ""
    if img:
        bits.append(f"déployé → {img}")
    return f"  {d:<24} [{branche}] " + " · ".join(bits)


def section_depots(addr, hdrs) -> list[str]:
    out = ["## DÉPÔTS — découverts sous " + SAAS_ROOT]
    liste = depots()
    if not liste:
        out.append(f"  ⁉ {IND} — aucun dépôt git trouvé sous {SAAS_ROOT}")
        return out
    jobs_images = images_des_jobs(addr, hdrs) if addr and restant() > 6 else {}
    if not jobs_images:
        out.append(f"  ⁉ images déployées : {IND} — jobs Nomad non lus dans le budget")
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        lignes = list(ex.map(lambda d: ligne_depot(d, jobs_images, addr, hdrs), liste))
    out += lignes
    return out


# ── §6 — Dépôt courant ──────────────────────────────────────────────────────
def depot_courant() -> str | None:
    cwd = os.path.realpath(os.getcwd())
    racine = os.path.realpath(SAAS_ROOT)
    if not cwd.startswith(racine + os.sep):
        return None
    reste = cwd[len(racine) + 1:].split(os.sep)[0]
    return reste if os.path.isdir(os.path.join(racine, reste, ".git")) else None


def section_courant() -> list[str]:
    d = depot_courant()
    if not d:
        return ["## DÉPÔT COURANT — hors dépôt SaaS, section sans objet"]
    chemin = os.path.join(SAAS_ROOT, d)
    out = [f"## DÉPÔT COURANT — {d}"]
    tete = git(chemin, "log", "-1", "--format=%h — %s")
    branche = git(chemin, "rev-parse", "--abbrev-ref", "HEAD")
    out.append(f"  HEAD : {branche} @ {tete}")

    statut = git(chemin, "status", "--short")
    if statut:
        lignes = statut.splitlines()
        out.append(f"  Arbre de travail : {len(lignes)} fichier(s) modifié(s)")
        out += [f"    {l}" for l in lignes[:8]]
        if len(lignes) > 8:
            out.append(f"    … (+{len(lignes)-8})")
    else:
        out.append("  Arbre de travail : propre ✓")

    # Garde-fous : audit statique, bon marché. Le dry-run réel exécute la suite
    # de tests du dépôt et coûte du CPU sur le poste à chaque session : il est
    # explicite (INFRA_STATUS_DRYRUN=1) plutôt que systématique.
    prepush = os.path.join(chemin, ".husky", "pre-push")
    if not os.path.exists(os.path.join(chemin, "package.json")):
        pass
    elif not os.path.exists(prepush):
        out.append("  Garde-fous : 🚨 .husky/pre-push ABSENT — rien ne protège le push")
    elif not git(chemin, "config", "core.hooksPath"):
        out.append("  Garde-fous : 🚨 hooksPath non configuré — husky est désactivé")
    else:
        manquants = []
        for s in sorted(set(re.findall(r"scripts/ci/[a-z0-9-]+\.sh",
                                       open(prepush, encoding="utf-8",
                                            errors="replace").read()))):
            if not os.access(os.path.join(chemin, s), os.X_OK):
                manquants.append(s)
        if manquants:
            out.append(f"  Garde-fous : 🚨 script(s) CI absent(s) : {', '.join(manquants)}")
        elif DRYRUN:
            code, sortie = sh(f"cd {chemin!r} && BASE_REF=origin/{branche} "
                              f"bash .husky/pre-push", min(20.0, restant()))
            if code == 0:
                out.append("  Garde-fous : ✓ pre-push exécuté, laisserait passer")
            elif code == 124:
                out.append(f"  Garde-fous : ⁉ {IND} — pre-push plus long que le budget")
            else:
                fin = " ".join(sortie.splitlines()[-3:])[:180]
                out.append(f"  Garde-fous : ✗ pre-push BLOQUERAIT — {fin}")
        else:
            out.append("  Garde-fous : ✓ audit statique OK (exécution réelle : "
                       "INFRA_STATUS_DRYRUN=1)")
    return out


# ── Rendu ───────────────────────────────────────────────────────────────────
def main() -> int:
    addr, hdrs, err = nomad_acces()

    # Les deux outils les plus lents partent en premier et sont récoltés en
    # dernier : leur latence se paie une fois, en recouvrement du reste.
    p_secu = lance_fond([f"{HOME}/all-cron/security/secu"], 0)
    p_obs = lance_fond("obs check 2>/dev/null | head -12", 0)
    p_state = lance_fond("nomad-v state 2>/dev/null", 0)

    horo = datetime.now().strftime("%Y-%m-%d %H:%M")
    poste = os.uname().nodename
    blocs = [f"# INFRA STATUS — {horo} — depuis {poste}",
             "# Tout ci-dessous est découvert à l'exécution. Une cible sans mesure "
             f"est marquée {IND} : elle n'est ni saine ni en panne, elle est à vérifier.",
             ""]

    for section in (section_flotte(addr, hdrs, err),
                    section_jobs(addr, hdrs),
                    section_ingress(addr, hdrs)):
        blocs += section + [""]

    # `nomad-v state` porte deux choses que rien d'autre ne rend ici : la santé
    # HTTP des routes telles que l'ingress les sert, et la preuve de sauvegarde.
    etat = ""
    if p_state is not None:
        try:
            etat, _ = p_state.communicate(timeout=max(1.0, min(12.0, restant(4))))
        except subprocess.TimeoutExpired:
            p_state.kill()
    etat = re.sub(r"\x1b\[[0-9;]*m", "", etat or "")

    blocs.append("## SANTÉ HTTP — routes telles que l'ingress les sert")
    sante = extrait_section(etat, "▓▓ SANTÉ HTTP", "▓▓ BACKUPS")
    if sante:
        blocs += [f"  {l.strip()}" for l in sante]
    else:
        blocs.append(f"  ⁉ {IND} — `nomad-v state` n'a pas rendu sa section santé HTTP. "
                     f"L'absence d'échec affiché ne veut pas dire que les routes passent.")
    blocs.append("")

    for section in (section_capacite(),
                    section_backups(etat),
                    section_depots(addr, hdrs)):
        blocs += section + [""]

    blocs.append("## VULNÉRABILITÉS — état recalculé par `secu`")
    entete = recolte(p_secu, min(24.0, restant(2)), "secu",
                     "Rejouer : ~/all-cron/security/secu")
    blocs += [l for l in entete[:5]]
    blocs.append("  → détail complet et constats priorisés : `~/all-cron/security/secu`")
    blocs.append("")

    blocs.append("## OBSERVABILITÉ — topiques rendus par `obs check`")
    blocs += recolte(p_obs, min(10.0, restant(1)), "obs check",
                     "Rejouer : obs check")
    blocs.append("")

    blocs += section_courant()

    fusibles = section_fusibles()
    if fusibles:
        blocs += [""] + fusibles

    if os.access(f"{HOME}/.local/bin/crypto", os.X_OK):
        code, ligne = sh([f"{HOME}/.local/bin/crypto", "facts", "--line"],
                         min(4.0, restant(1)))
        if code == 0 and ligne.strip():
            blocs += ["", "## CRYPTO — constantes à garder en tête (`crypto facts`)"]
            blocs += [f"  {l}" for l in ligne.strip().splitlines()]

    blocs.append("")
    blocs.append(f"— rendu en {time.monotonic() - DEBUT:.1f}s "
                 f"(budget {BUDGET:.0f}s)")
    print("\n".join(blocs))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        # Un hook qui plante ne doit jamais empêcher une session de démarrer,
        # mais il doit le dire : un bloc absent en silence, c'est exactement le
        # « pas de mesure lu comme pas de problème » que ce fichier combat.
        print(f"# INFRA STATUS — {IND} : le hook a échoué "
              f"({type(e).__name__}: {e}).\n"
              f"# N'en conclure AUCUN état de l'infrastructure. "
              f"Rejouer : python3 {os.path.abspath(__file__)}")
        sys.exit(0)
