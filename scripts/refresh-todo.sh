#!/usr/bin/env bash
# refresh-todo.sh — Génère TODO.md à la racine veridian-platform/ en
# scannant todo/ et todo/done/ de chaque repo.
#
# Usage : ./scripts/refresh-todo.sh  (depuis la racine veridian-platform/)
# Ou via Makefile : make refresh-todo
#
# Sortie : TODO.md à la racine, écrasé à chaque run.
#
# Convention attendue par repo (cf. CLAUDE-ROOT.md §"Convention todo/")
#   <repo>/todo/                     ← tickets pending (markdown)
#   <repo>/todo/done/                ← archive tickets résolus
#   <repo>/todo/blocked/ (optionnel) ← en attente externe
#   <repo>/todo/apps/   (optionnel)  ← sous-tickets app-specific
#   <repo>/todo/integrations/ (opt.) ← spec contrats cross-app
#
# Chaque ticket .md est extrait :
#   - Titre = première ligne `# Titre` ou nom de fichier si pas de h1
#   - Sévérité = ligne contenant "Sévérité :" (P0/P1/P2/P3) si présente
#   - Date = depuis le nom de fichier YYYY-MM-DD-*

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/TODO.md"

# Liste des repos à scanner (peut être surchargée via env REPOS).
REPOS="${REPOS:-veridian-hub veridian-prospection veridian-analytics veridian-cms notifuse-veridian veridian-infra}"

# extract_title <file> → titre du ticket (h1 markdown, ou nom de fichier).
extract_title() {
  local f="$1"
  local title
  # Première ligne `# Titre` (h1 markdown), strip "# " préfixe.
  title=$(grep -m1 '^# ' "$f" 2>/dev/null | sed 's/^# *//' || true)
  if [ -z "$title" ]; then
    title=$(basename "$f" .md)
  fi
  # Strip emoji 🔒 ❌ etc. en début éventuel + tronquer 100 chars.
  printf '%s' "$title" | sed 's/^[[:space:]]*//' | cut -c1-100
}

# extract_severity <file> → "🔴 P0" / "🟡 P1" / "🟢 P2" / "🔵 P3" / "—" si pas trouvé.
extract_severity() {
  local f="$1"
  local sev_line
  sev_line=$(grep -m1 -iE "Sévérité|severity" "$f" 2>/dev/null || true)
  if [ -z "$sev_line" ]; then
    echo "—"
    return
  fi
  # Tente de détecter P0/P1/P2/P3
  case "$sev_line" in
    *P0*) echo "🔴 P0" ;;
    *P1*) echo "🟡 P1" ;;
    *P2*) echo "🟢 P2" ;;
    *P3*) echo "🔵 P3" ;;
    *)    echo "—" ;;
  esac
}

# extract_date <file> → YYYY-MM-DD depuis le nom ou "—".
extract_date() {
  local f="$1"
  local base
  base=$(basename "$f" .md)
  if [[ "$base" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "—"
  fi
}

# is_ticket_file <basename> → return 0 si le nom commence par YYYY-MM-DD-
# (= un ticket horodaté), sinon return 1 (= une note thématique style
# README.md, SPRINT.md, CI-TODO.md, SECURITY-CVE.md, etc.).
is_ticket_file() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}- ]]
}

# render_section <repo> <subdir> <heading> [filter] — liste les .md de
# <repo>/todo/<subdir>/ en table markdown. Skip si dossier absent ou vide.
# <subdir> avec slash de tête (ex: "/done") ou vide pour la racine de todo/.
# <filter> = "tickets" (défaut) → seulement les YYYY-MM-DD-* ;
#         = "notes"             → seulement les fichiers thématiques ;
#         = "all"               → tout.
render_section() {
  local repo="$1"
  local subdir="$2"
  local heading="$3"
  local filter="${4:-tickets}"
  local dir
  if [ -z "$subdir" ]; then
    dir="$ROOT/$repo/todo"
  else
    dir="$ROOT/$repo/todo${subdir}"
  fi
  shopt -s nullglob
  local all_files=("$dir"/*.md)
  shopt -u nullglob

  # Filtre selon mode.
  local files=()
  for f in "${all_files[@]}"; do
    local base
    base=$(basename "$f" .md)
    case "$filter" in
      tickets)
        is_ticket_file "$base" && files+=("$f")
        ;;
      notes)
        is_ticket_file "$base" || files+=("$f")
        ;;
      all)
        files+=("$f")
        ;;
    esac
  done

  if [ ${#files[@]} -eq 0 ]; then
    return
  fi
  printf '\n#### %s (%d)\n\n' "$heading" "${#files[@]}"
  printf '| Date | Sév | Titre | Fichier |\n'
  printf '|---|---|---|---|\n'
  # Tri par nom (= par date pour les YYYY-MM-DD-*).
  for f in $(printf '%s\n' "${files[@]}" | sort); do
    local title sev date relpath
    title=$(extract_title "$f")
    sev=$(extract_severity "$f")
    date=$(extract_date "$f")
    relpath="${f#$ROOT/}"
    # Échappe les pipes dans le titre pour ne pas casser la table markdown.
    title=${title//|/\\|}
    printf '| %s | %s | %s | [%s](%s) |\n' "$date" "$sev" "$title" "$(basename "$f")" "$relpath"
  done
}

# count_files <dir> → nombre de .md, 0 si dir absent.
count_files() {
  local d="$1"
  if [ ! -d "$d" ]; then
    echo 0
    return
  fi
  shopt -s nullglob
  local arr=("$d"/*.md)
  shopt -u nullglob
  echo "${#arr[@]}"
}

# Génère le fichier TODO.md complet.
{
  printf '# TODO Veridian — vue cross-app\n\n'
  printf '> Index dynamique généré par `scripts/refresh-todo.sh` —\n'
  printf '> dernière régénération : `%s` (UTC `%s`)\n' "$(date '+%Y-%m-%d %H:%M %z')" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '>\n'
  printf '> **Conventions** :\n'
  printf '> - Tickets pending = `<repo>/todo/*.md`\n'
  printf '> - Tickets done    = `<repo>/todo/done/*.md`\n'
  printf '> - Tickets blocked = `<repo>/todo/blocked/*.md` (en attente externe)\n'
  printf '> - Format ticket   = `YYYY-MM-DD-<slug>.md` avec header `## Sévérité`\n'
  printf '> - Pour archiver   = `mv <repo>/todo/X.md <repo>/todo/done/`\n'
  printf '>\n'
  printf '> Source de vérité pricing & trial : [veridian-hub/docs/PRICING-VERIDIAN.md](veridian-hub/docs/PRICING-VERIDIAN.md)\n'
  printf '> Contrat technique cross-app : [veridian-hub/docs/CONTRAT-HUB.md](veridian-hub/docs/CONTRAT-HUB.md)\n\n'

  # Navigation rapide — table de saut par repo. Chaque agent jump directement
  # sur SA section via l'ancre, ne charge pas le contexte des autres apps.
  printf '## 🎯 Sauter directement à mon repo\n\n'
  printf 'Chaque agent ne devrait charger que sa section. Cliquer pour jump.\n'
  printf 'Pour un grep ciblé : `grep -A 50 "## 📁 <mon-repo>" TODO.md`\n\n'
  for repo in $REPOS; do
    pending=$(count_files "$ROOT/$repo/todo")
    done_n=$(count_files "$ROOT/$repo/todo/done")
    blocked=$(count_files "$ROOT/$repo/todo/blocked")
    anchor=$(echo "$repo" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
    printf -- '- 📁 **[%s](#-%s)** — `%s/todo/` → %d pending · %d done · %d blocked\n' \
      "$repo" "$anchor" "$repo" "$pending" "$done_n" "$blocked"
  done
  printf '\n**Sections globales** :\n'
  printf -- "- [Vue d'ensemble (totaux)](#vue-densemble)\n"
  printf -- '- [🗄️ Done — archives toutes apps](#%%EF%%B8%%8F-done--archives-toutes-apps) (en fin de fichier)\n\n'

  # Récap top — totaux par repo.
  printf "## Vue d'ensemble\n\n"
  printf '| Repo | Pending | Done | Blocked | Total |\n'
  printf '|---|---|---|---|---|\n'
  for repo in $REPOS; do
    local_pending=$(count_files "$ROOT/$repo/todo")
    local_done=$(count_files "$ROOT/$repo/todo/done")
    local_blocked=$(count_files "$ROOT/$repo/todo/blocked")
    local_total=$((local_pending + local_done + local_blocked))
    printf '| **%s** | %d | %d | %d | %d |\n' "$repo" "$local_pending" "$local_done" "$local_blocked" "$local_total"
  done

  # Sections détaillées par repo.
  for repo in $REPOS; do
    pending_count=$(count_files "$ROOT/$repo/todo")
    done_count=$(count_files "$ROOT/$repo/todo/done")
    blocked_count=$(count_files "$ROOT/$repo/todo/blocked")
    total=$((pending_count + done_count + blocked_count))
    if [ "$total" -eq 0 ]; then
      continue
    fi
    printf '\n---\n\n## 📁 %s\n\n' "$repo"
    printf 'Path : `%s/`\n' "$repo"
    printf 'Todo : `%s/todo/`\n' "$repo"
    render_section "$repo" ""              "Pending"                                       tickets
    render_section "$repo" ""              "Notes thématiques (README, SPRINT, SECURITY…)" notes
    render_section "$repo" "/blocked"      "Blocked (en attente externe)"                  tickets
    render_section "$repo" "/apps"         "Cross-app (sous-tickets app-specific)"         tickets
    render_section "$repo" "/integrations" "Integrations (specs contrats)"                 tickets
  done

  # Section globale done à la FIN — vue d'ensemble des archives cross-app.
  printf '\n---\n\n'
  printf '# 🗄️ Done — archives (toutes apps)\n\n'
  printf '> Tickets résolus et archivés. Conservés pour mémoire et\n'
  printf '> rétrospective. Pour réouvrir un done, le ramener dans `todo/`.\n\n'

  total_done=0
  for repo in $REPOS; do
    count=$(count_files "$ROOT/$repo/todo/done")
    total_done=$((total_done + count))
  done
  printf 'Total : **%d tickets archivés** cross-app.\n' "$total_done"

  for repo in $REPOS; do
    count=$(count_files "$ROOT/$repo/todo/done")
    if [ "$count" -eq 0 ]; then
      continue
    fi
    printf '\n## 📁 %s — done\n\n' "$repo"
    printf 'Path : `%s/todo/done/`\n' "$repo"
    render_section "$repo" "/done" "Archive" tickets
  done

  printf '\n---\n\n'
  printf '_Régénéré par `./scripts/refresh-todo.sh` — ne PAS éditer ce fichier à la main._\n'
} > "$OUT"

echo "✓ Régénéré $OUT"
echo "  Total tickets pending : $(grep -c '^| 20' "$OUT" 2>/dev/null || echo 0)"
