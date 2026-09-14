#!/bin/bash
###############################################################################
# infra-status.sh — Veridian infrastructure snapshot at Claude Code SessionStart
#
# Versionné dans veridian-hub/scripts/ops/claude-hooks/
# Symlinké depuis ~/.claude/hooks/infra-status.sh
#
# Sortie composée de 3 sections, dans cet ordre :
#
#   §1  GLOBAL INFRA         : ressources machines, services systemd, routes
#                              Traefik live, état stack obs (Grafana Cloud)
#   §2  SAAS OVERVIEW        : pipeline live (auto-promote / rollback / runs en
#                              cours) + cross-repo summary (1 bloc/repo)
#   §3  CURRENT REPO         : photo détaillée du repo où Claude est lancé
#
# Pas de cache : Robert remplit sa queue de messages pendant que le hook tourne,
# donc la latence (~15-25s à froid) n'est pas bloquante. La sortie va dans le
# context de Claude au SessionStart.
#
# ─── NOTE POUR LES AGENTS ─────────────────────────────────────────────────────
# Ce script peut être édité par n'importe quel agent au cours du projet pour
# fix un bug, ajouter un signal pertinent, ou améliorer la lisibilité. Il vit
# dans veridian-hub/scripts/ops/claude-hooks/ et est symlinké depuis
# ~/.claude/hooks/. Commit dans Hub, push staging — tous les agents bénéficient
# de l'amélioration au prochain SessionStart.
#
# Avant de modifier :
#   1. Tester le rendu avec `bash ~/.claude/hooks/infra-status.sh` depuis le
#      repo concerné (ou un autre repo SaaS).
#   2. Garder la latence < 30s (parallélisation via `( ... ) &` + `wait`).
#   3. Maintenir le principe "silence = OK" en §2 : seuls les signaux
#      actionnables apparaissent. Le détail riche reste en §3.
#   4. Si une app est ajoutée/retirée du SaaS, mettre à jour SAAS_REPOS +
#      les helpers saas_* en début de fichier.
###############################################################################

SSH_TIMEOUT=8
CURL_TIMEOUT=5
HOSTNAME_SHORT="$(hostname -s)"
SAAS_ROOT="/home/brunon5/Bureau/veridian-platform"
SSH_KEY="$HOME/.ssh/id_rsa_ovh"
NOMAD_V="${NOMAD_V:-/home/brunon5/bin/nomad-v}"

###############################################################################
# SaaS repo mapping (single source of truth)
###############################################################################

SAAS_REPOS=(
    "veridian-hub"
    "veridian-prospection"
    "veridian-analytics"
    "veridian-cms"
    "notifuse-veridian"
    "veridian-infra"
)

saas_ghcr_pkg() {
    case "$1" in
        veridian-hub)          echo "veridian-hub" ;;
        veridian-prospection)  echo "prospection" ;;
        veridian-analytics)    echo "analytics" ;;
        veridian-cms)          echo "veridian-cms" ;;
        notifuse-veridian)     echo "notifuse-veridian" ;;
        *)                     echo "" ;;
    esac
}

saas_prod_container_pattern() {
    case "$1" in
        veridian-hub)          echo "nl2k9p-hub" ;;
        veridian-prospection)  echo "l5fmki-prospection" ;;
        veridian-analytics)    echo "i9bv43-analytics" ;;
        veridian-cms)          echo "e9xlnn-cms" ;;
        notifuse-veridian)     echo "k9lvap-notifuse" ;;
        *)                     echo "" ;;
    esac
}

saas_staging_container_pattern() {
    case "$1" in
        veridian-hub)          echo "^hub-staging$" ;;
        veridian-prospection)  echo "prospection-staging" ;;
        veridian-analytics)    echo "analytics-engine-staging$" ;;
        veridian-cms)          echo "^cms-staging$" ;;
        notifuse-veridian)     echo "^notifuse-staging$" ;;
        *)                     echo "" ;;
    esac
}

# Auto-promote policy — source vérifiée 2026-05-19 via git log (commits auto-promote détectés)
# Source initiale : veridian-hub/todo/2026-05-19-auto-promote-staging-main.md
saas_promote_policy() {
    case "$1" in
        veridian-cms)          echo "auto" ;;
        notifuse-veridian)     echo "auto" ;;
        veridian-prospection)  echo "auto" ;;        # câblé 2026-05-19 — auto-promote confirmé par git log
        veridian-hub)          echo "manual" ;;      # TODO câbler (ticket 2026-05-19-auto-promote-staging-main.md)
        veridian-analytics)    echo "manual" ;;      # TODO câbler
        veridian-infra)        echo "n/a" ;;
        *)                     echo "?" ;;
    esac
}

saas_policy_badge() {
    case "$1" in
        auto)             echo "🤖" ;;
        manual)           echo "✋" ;;
        critical-manual)  echo "🔒" ;;
        n/a)              echo "·" ;;
        *)                echo "?" ;;
    esac
}

saas_policy_label() {
    case "$1" in
        auto)             echo "🤖 auto-promote câblé (staging vert → main → prod)" ;;
        manual)           echo "✋ promotion manuelle (auto-promote à câbler)" ;;
        critical-manual)  echo "🔒 promotion manuelle volontaire (app critique)" ;;
        n/a)              echo "—" ;;
        *)                echo "?" ;;
    esac
}

###############################################################################
# Generic helpers
###############################################################################

iso_to_age() {
    local iso="$1"
    [ -z "$iso" ] && { echo "?"; return; }
    local t; t=$(date -d "$iso" +%s 2>/dev/null || echo 0)
    [ "$t" = 0 ] && { echo "?"; return; }
    local diff=$(( $(date +%s) - t ))
    if [ "$diff" -lt 3600 ]; then echo "$((diff/60))min"
    elif [ "$diff" -lt 86400 ]; then echo "$((diff/3600))h"
    else echo "$((diff/86400))d"; fi
}

ci_glyph() {
    case "$1" in
        success)    echo "✓" ;;
        failure)    echo "✗" ;;
        cancelled)  echo "⊘" ;;
        skipped)    echo "⊝" ;;
        in_progress|queued|"") echo "●" ;;
        *)          echo "?" ;;
    esac
}

local_resources() {
    local cpu ram_pct ram_used ram_total disk_used disk_total disk_pct disk_info ram_avail
    cpu="$(awk 'NR==1 {u=$2+$4; t=$2+$4+$5; if(t>0) printf "%d", u*100/t}' /proc/stat 2>/dev/null || echo "?")"
    ram_total="$(awk '/^MemTotal:/ {printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null)"
    ram_avail="$(awk '/^MemAvailable:/ {printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null)"
    ram_used="$(echo "$ram_total $ram_avail" | awk '{printf "%.1f", $1-$2}')"
    ram_pct="$(echo "$ram_total $ram_avail" | awk '{if($1>0) printf "%d", ($1-$2)*100/$1}')"
    disk_info="$(df -h / 2>/dev/null | awk 'NR==2 {print $3"|"$2"|"$5}')"
    disk_used="${disk_info%%|*}"
    disk_total="$(echo "$disk_info" | cut -d'|' -f2)"
    disk_pct="$(echo "$disk_info" | cut -d'|' -f3 | tr -d '%')"
    echo "CPU:${cpu}% | RAM:${ram_used}/${ram_total}G (${ram_pct}%) | Disk:${disk_used}/${disk_total} (${disk_pct}%)"
}

remote_resources() {
    local ssh_cmd
    if [ "$1" = "--alias" ]; then
        ssh_cmd="timeout $SSH_TIMEOUT ssh -o ConnectTimeout=5 -o BatchMode=yes $2"
    else
        local host="$1" key="${2:-$SSH_KEY}" user="${3:-ubuntu}"
        ssh_cmd="timeout $SSH_TIMEOUT ssh -i $key -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${user}@${host}"
    fi
    $ssh_cmd '
        ram_total=$(awk "/^MemTotal:/ {printf \"%.1f\", \$2/1048576}" /proc/meminfo)
        ram_avail=$(awk "/^MemAvailable:/ {printf \"%.1f\", \$2/1048576}" /proc/meminfo)
        ram_used=$(echo "$ram_total $ram_avail" | awk "{printf \"%.1f\", \$1-\$2}")
        ram_pct=$(echo "$ram_total $ram_avail" | awk "{if(\$1>0) printf \"%d\", (\$1-\$2)*100/\$1}")
        disk_info=$(df -h / | awk "NR==2 {print \$3\"|\"\$2\"|\"\$5}")
        disk_used=$(echo "$disk_info" | cut -d"|" -f1)
        disk_total=$(echo "$disk_info" | cut -d"|" -f2)
        disk_pct=$(echo "$disk_info" | cut -d"|" -f3 | tr -d "%")
        echo "RAM:${ram_used}/${ram_total}G (${ram_pct}%) | Disk:${disk_used}/${disk_total} (${disk_pct}%)"
    ' 2>/dev/null || echo "UNREACHABLE"
}

remote_docker() {
    local host="$1" key="${2:-$SSH_KEY}" user="${3:-ubuntu}"
    timeout "$SSH_TIMEOUT" ssh -i "$key" -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes \
        "${user}@${host}" '
        running=$(docker ps -q 2>/dev/null | wc -l)
        total=$(docker ps -aq 2>/dev/null | wc -l)
        unhealthy=$(docker ps --filter "health=unhealthy" -q 2>/dev/null | wc -l)
        exited=$(docker ps -a --filter "status=exited" --format "{{.Names}}|{{.Status}}" 2>/dev/null | grep -v "Exited (0)" | head -5)
        unhealthy_names=$(docker ps --filter "health=unhealthy" --format "{{.Names}}" 2>/dev/null | head -5)
        echo "Running:${running}/${total}"
        if [ "$unhealthy" -gt 0 ]; then echo "UNHEALTHY:${unhealthy} [${unhealthy_names}]"; fi
        if [ -n "$exited" ]; then echo "CRASHED:"; echo "$exited"; fi
    ' 2>/dev/null || echo "UNREACHABLE"
}

remote_services() {
    local ssh_cmd services
    if [ "$1" = "--alias" ]; then
        ssh_cmd="timeout $SSH_TIMEOUT ssh -o ConnectTimeout=5 -o BatchMode=yes $2"
        services="$3"
    else
        local host="$1" key="${2:-$SSH_KEY}" user="${3:-ubuntu}"
        ssh_cmd="timeout $SSH_TIMEOUT ssh -i $key -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${user}@${host}"
        services="$4"
    fi
    $ssh_cmd "for svc in ${services}; do status=\$(systemctl is-active \${svc}.service 2>/dev/null || echo 'missing'); echo \"\${svc}: \${status}\"; done" 2>/dev/null \
        || echo "UNREACHABLE"
}

local_services() {
    for svc in $1; do
        status="$(systemctl is-active ${svc}.service 2>/dev/null || echo 'missing')"
        echo "${svc}: ${status}"
    done
}

###############################################################################
# SaaS helpers (GHCR, CI, images, pipeline events)
###############################################################################

ghcr_digest_meta() {
    local pkg="$1" digest="$2"
    [ -z "$pkg" ] || [ -z "$digest" ] && return
    gh api "/users/christ-roy/packages/container/${pkg}/versions?per_page=100" \
        --jq ".[] | select(.name == \"${digest}\") | (.metadata.container.tags | join(\",\")) + \"|\" + .updated_at" 2>/dev/null | head -1
}

ghcr_resolve_git_sha() {
    local repo="$1" tags="$2" updated="$3"
    local sha
    sha=$(echo "$tags" | tr ',' '\n' | grep -oP '^(staging|main)-\K[a-f0-9]{7,}' | head -1)
    [ -n "$sha" ] && { echo "${sha:0:7}"; return; }
    [ -z "$updated" ] && return
    sha=$(gh api "/repos/Christ-Roy/${repo}/actions/runs?branch=main&status=success&per_page=20" \
        --jq ".workflow_runs | map(select(.created_at <= \"${updated}\")) | sort_by(.created_at) | reverse | .[0].head_sha" 2>/dev/null)
    [ -n "$sha" ] && [ "$sha" != "null" ] && echo "${sha:0:7}"
}

saas_prod_image_info() {
    local repo="$1"
    local pattern; pattern=$(saas_prod_container_pattern "$repo")
    [ -z "$pattern" ] && { echo "n/a|n/a|n/a"; return; }
    local info
    info=$(timeout "$SSH_TIMEOUT" ssh -i "$SSH_KEY" -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes \
        "ubuntu@100.88.202.29" "
        cname=\$(docker ps --format '{{.Names}}' | grep '$pattern' | head -1)
        [ -z \"\$cname\" ] && exit
        img=\$(docker inspect \"\$cname\" --format '{{.Config.Image}}' 2>/dev/null)
        repo_digest=\$(docker image inspect \"\$img\" --format '{{index .RepoDigests 0}}' 2>/dev/null)
        started=\$(docker inspect \"\$cname\" --format '{{.State.StartedAt}}' 2>/dev/null)
        echo \"\$img|\$repo_digest|\$started\"
    " 2>/dev/null)
    [ -z "$info" ] && { echo "n/a|n/a|n/a"; return; }
    local img="${info%%|*}"
    local rest="${info#*|}"
    local repo_digest="${rest%%|*}"
    local started="${rest#*|}"
    local digest="${repo_digest##*@}"
    local pkg; pkg=$(saas_ghcr_pkg "$repo")
    local meta tags updated git_sha tag_display
    if [ -n "$pkg" ] && [ -n "$digest" ]; then
        meta=$(ghcr_digest_meta "$pkg" "$digest")
        tags="${meta%%|*}"
        updated="${meta##*|}"
        git_sha=$(ghcr_resolve_git_sha "$repo" "$tags" "$updated")
        tag_display=$(echo "$tags" | tr ',' '\n' | grep -E '^v[0-9]' | head -1)
        [ -z "$tag_display" ] && tag_display=$(echo "$tags" | tr ',' '\n' | grep -vE '^(latest)$' | head -1)
        [ -z "$tag_display" ] && tag_display="latest"
    else
        tag_display="$img"
        git_sha="?"
    fi
    local age; age=$(iso_to_age "$started")
    echo "${tag_display}|${git_sha:-?}|${age}"
}

saas_staging_image_info() {
    local repo="$1"
    local pattern; pattern=$(saas_staging_container_pattern "$repo")
    [ -z "$pattern" ] && { echo "n/a|n/a|n/a"; return; }
    local info
    info=$(timeout "$SSH_TIMEOUT" ssh -o ConnectTimeout=3 -o BatchMode=yes dev-pub "
        cname=\$(docker ps --format '{{.Names}}' | grep -E '$pattern' | head -1)
        [ -z \"\$cname\" ] && exit
        img=\$(docker inspect \"\$cname\" --format '{{.Config.Image}}' 2>/dev/null)
        started=\$(docker inspect \"\$cname\" --format '{{.State.StartedAt}}' 2>/dev/null)
        echo \"\$img|\$started\"
    " 2>/dev/null)
    [ -z "$info" ] && { echo "n/a|n/a|n/a"; return; }
    local img="${info%%|*}"
    local started="${info##*|}"
    local img_clean="${img%@*}"
    local tag="${img_clean##*:}"
    local git_sha
    git_sha=$(echo "$tag" | grep -oP '^staging-\K[a-f0-9]{7,}' | head -c 7)
    [ -z "$git_sha" ] && git_sha=$(echo "$tag" | grep -oP '\.[a-f0-9]{7,}$' | tr -d '.' | head -c 7)
    [ -z "$git_sha" ] && git_sha=$(echo "$tag" | grep -oP '[a-f0-9]{7,}' | head -1 | head -c 7)
    local age; age=$(iso_to_age "$started")
    echo "${tag}|${git_sha:-?}|${age}"
}

saas_image_lag() {
    local repo="$1" deployed_tag="$2"
    local pkg; pkg=$(saas_ghcr_pkg "$repo")
    [ -z "$pkg" ] || [ -z "$deployed_tag" ] && return
    local latest_info
    latest_info=$(gh api "/users/christ-roy/packages/container/${pkg}/versions?per_page=20" \
        --jq '[.[] | select(.metadata.container.tags | length > 0 and (any(. == "rollback") | not))]
              | sort_by(.updated_at) | reverse | .[0]
              | (.metadata.container.tags | join(",")) + "|" + .updated_at' 2>/dev/null)
    [ -z "$latest_info" ] && return
    local latest_tags="${latest_info%%|*}"
    local latest_at="${latest_info##*|}"
    local latest_tag
    latest_tag=$(echo "$latest_tags" | tr ',' '\n' | grep -E '^(v[0-9]|staging-|main-)' | head -1)
    [ -z "$latest_tag" ] && latest_tag=$(echo "$latest_tags" | tr ',' '\n' | grep -vE '^(latest)$' | head -1)
    [ "$deployed_tag" = "$latest_tag" ] && return
    echo "$latest_tags" | tr ',' '\n' | grep -qx "$deployed_tag" && return
    local age; age=$(iso_to_age "$latest_at")
    echo "${latest_tag} (built ${age})"
}

saas_running_ci() {
    local repo="$1"
    gh run list --repo "Christ-Roy/${repo}" --limit 30 \
        --json workflowName,headBranch,createdAt,databaseId,event,status \
        --jq '.[] | select(.status == "in_progress" or .status == "queued") | "\(.workflowName)|\(.headBranch)|\(.createdAt)|\(.databaseId)|\(.event)"' 2>/dev/null
}

saas_recent_autopromote() {
    local repo="$1"
    local d="$SAAS_ROOT/$repo"
    [ ! -d "$d/.git" ] && return
    local hit
    hit=$(git -C "$d" log origin/main --since='6 hours ago' --format='%H|%aI|%s' 2>/dev/null \
        | grep -iE 'auto.promote|promote.*staging|merge.*staging' | head -1)
    [ -n "$hit" ] && { echo "$hit"; return; }
    gh run list --repo "Christ-Roy/${repo}" --limit 15 --status success \
        --json workflowName,headBranch,createdAt,displayTitle,databaseId \
        --jq '.[] | select(.workflowName | test("[Pp]romote")) | "\(.databaseId)|\(.createdAt)|promote-job: \(.displayTitle)"' 2>/dev/null | head -1
}

# Vrai rollback ⇒ on regarde 2 signaux qui prouvent qu'un basculement a eu lieu :
#   (1) L'image actuellement en prod a le tag `rollback` sur GHCR
#       (= prod tourne explicitement sur l'image-de-secours).
#   (2) Un commit `revert:` / `rollback:` est arrivé sur main < 24h.
# Le tag `rollback` posé sur GHCR EST une convention CI : la dernière image
# success est marquée comme "image de rollback prête". Sa simple présence ne
# prouve PAS qu'un rollback a été déclenché — c'est juste l'image de secours
# disponible. Ne PAS prendre updated_at du tag rollback comme signal.
saas_recent_rollback() {
    local repo="$1"
    # Signal 1 : image prod actuelle porte le tag rollback ?
    local pkg; pkg=$(saas_ghcr_pkg "$repo")
    if [ -n "$pkg" ]; then
        local pattern; pattern=$(saas_prod_container_pattern "$repo")
        if [ -n "$pattern" ]; then
            local current_digest
            current_digest=$(timeout "$SSH_TIMEOUT" ssh -i "$SSH_KEY" -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes \
                "ubuntu@100.88.202.29" "
                cname=\$(docker ps --format '{{.Names}}' | grep '$pattern' | head -1)
                [ -z \"\$cname\" ] && exit
                img=\$(docker inspect \"\$cname\" --format '{{.Config.Image}}' 2>/dev/null)
                docker image inspect \"\$img\" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//'
            " 2>/dev/null)
            if [ -n "$current_digest" ]; then
                local rb_digest
                rb_digest=$(gh api "/users/christ-roy/packages/container/${pkg}/versions?per_page=50" \
                    --jq '.[] | select(.metadata.container.tags | index("rollback")) | .name' 2>/dev/null | head -1)
                if [ -n "$rb_digest" ] && [ "$current_digest" = "$rb_digest" ]; then
                    # Prod tourne sur l'image rollback → vrai rollback actif
                    local rb_at
                    rb_at=$(gh api "/users/christ-roy/packages/container/${pkg}/versions?per_page=50" \
                        --jq '.[] | select(.metadata.container.tags | index("rollback")) | .updated_at' 2>/dev/null | head -1)
                    echo "active|${rb_at}|prod tourne sur image rollback (digest ${current_digest:7:12})"
                    return
                fi
            fi
        fi
    fi
    # Signal 2 : commit revert/rollback récent sur main
    local d="$SAAS_ROOT/$repo"
    if [ -d "$d/.git" ]; then
        local hit
        hit=$(git -C "$d" log origin/main --since='24 hours ago' --format='%H|%aI|%s' 2>/dev/null \
            | grep -iE '^[^|]+\|[^|]+\|(revert|rollback)[:(]' | head -1)
        [ -n "$hit" ] && { echo "$hit"; return; }
    fi
    # Sinon rien — pas de rollback détecté
}

# ─── Guardrails (husky pre-push) ─────────────────────────────────────────────
# Donne un verdict explicite par repo. 3 niveaux :
#   ✓ trusted        : husky actif + scripts critiques présents + tests-pending sain
#   ⚠ check-yourself : anomalie détectée, l'agent doit vérifier .husky/pre-push manuellement
#   ✗ broken         : husky désactivé / pre-push absent / scripts critiques absents
#
# Audit statique uniquement (rapide). Le dry-run réel du pre-push est fait UNIQUEMENT
# pour le repo courant en §3 (trop coûteux pour les 6 repos).
saas_guardrails_audit() {
    local r="$1"
    local d="$SAAS_ROOT/$r"
    local issues=()

    # Repos sans stack Node : husky/pre-push n'a pas de sens (couverture = Trivy quotidien)
    case "$r" in
        veridian-infra) echo "✓ trusted|n/a — repo infra sans stack Node"; return ;;
    esac

    # 1. Husky configuré ?
    local hp; hp=$(git -C "$d" config core.hooksPath 2>/dev/null)
    if [ -z "$hp" ]; then
        issues+=("hooksPath non configuré (husky désactivé)")
    fi

    # 2. pre-push existe + exécutable ?
    if [ ! -f "$d/.husky/pre-push" ]; then
        issues+=(".husky/pre-push ABSENT")
    elif [ ! -x "$d/.husky/pre-push" ]; then
        issues+=(".husky/pre-push non exécutable")
    fi

    # 3. Scripts critiques présents (s'ils sont référencés dans pre-push) ?
    if [ -f "$d/.husky/pre-push" ]; then
        local pp; pp="$d/.husky/pre-push"
        while IFS= read -r script; do
            local script_path="$d/$script"
            if [ ! -x "$script_path" ]; then
                issues+=("script CI manquant: $script")
            fi
        done < <(grep -oE 'scripts/ci/[a-z-]+\.sh' "$pp" 2>/dev/null | sort -u)
    fi

    # 4. tests-pending : dette trop grosse (> 10 entrées) ?
    local tp_count=0
    if [ -f "$d/scripts/ci/tests-pending.txt" ]; then
        tp_count=$(grep -cvE '^\s*(#|$)' "$d/scripts/ci/tests-pending.txt" 2>/dev/null)
        if [ "$tp_count" -gt 10 ]; then
            issues+=("tests-pending: ${tp_count} entrées (dette qui dérive)")
        fi
    fi

    # 5. Croissance récente tests-pending (commit dans les 7j) ?
    if [ -f "$d/scripts/ci/tests-pending.txt" ]; then
        local recent_change
        recent_change=$(git -C "$d" log --since='7 days ago' --oneline -- scripts/ci/tests-pending.txt 2>/dev/null | wc -l)
        if [ "$recent_change" -gt 0 ]; then
            issues+=("tests-pending modifié ${recent_change}× ces 7j")
        fi
    fi

    # Verdict
    if [ ${#issues[@]} -eq 0 ]; then
        local meta="audit statique OK"
        [ "$tp_count" -gt 0 ] && meta="audit OK, tests-pending:${tp_count}"
        echo "✓ trusted|${meta}"
    elif [ ${#issues[@]} -le 1 ] && [[ "${issues[0]}" == *"tests-pending"* ]]; then
        echo "⚠ check-yourself|${issues[*]}"
    else
        # ≥ 1 issue structurelle (husky / pre-push / scripts) → broken
        local has_structural=0
        for i in "${issues[@]}"; do
            [[ "$i" == *"hooksPath"* ]] || [[ "$i" == *"pre-push"* ]] || [[ "$i" == *"script CI"* ]] && has_structural=1
        done
        if [ "$has_structural" = 1 ]; then
            echo "✗ broken|${issues[*]}"
        else
            echo "⚠ check-yourself|${issues[*]}"
        fi
    fi
}

# Dry-run réel du pre-push pour le repo courant — exécution sandboxée
saas_guardrails_dryrun() {
    local r="$1"
    local d="$SAAS_ROOT/$r"
    [ ! -f "$d/.husky/pre-push" ] && { echo "skip|pre-push absent"; return; }
    local default_base="origin/$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    local out exit_code
    # Run in subshell to isolate cwd
    out=$( (cd "$d" && timeout 25 env BASE_REF="$default_base" bash .husky/pre-push 2>&1) )
    exit_code=$?
    if [ "$exit_code" = 0 ]; then
        echo "✓|exit=0 — pre-push laisserait passer"
    elif [ "$exit_code" = 124 ]; then
        echo "?|timeout >25s — pre-push trop lent ou bloqué (vérifier manuellement)"
    else
        # Garder dernières 5 lignes pour comprendre ce qui a fail
        local summary
        summary=$(echo "$out" | tail -5 | tr '\n' ' ' | sed 's/\x1b\[[0-9;]*m//g')
        echo "✗|exit=${exit_code} — pre-push BLOQUERAIT: ${summary:0:200}"
    fi
}

detect_current_saas_repo() {
    local cwd="${PWD}"
    for r in "${SAAS_REPOS[@]}"; do
        [[ "$cwd" == "$SAAS_ROOT/$r"* ]] && { echo "$r"; return; }
    done
    if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        local url; url=$(git -C "$cwd" remote get-url origin 2>/dev/null)
        for r in "${SAAS_REPOS[@]}"; do
            if [[ "$url" == *"/${r}.git" ]] || [[ "$url" == *"/${r}" ]]; then
                echo "$r"
                return
            fi
        done
    fi
}

# ─── Rétention R2 complémentaire au snapshot cross-nœud de nomad-v ───────────
RCLONE_BIN="$(command -v rclone 2>/dev/null || true)"
[ -z "$RCLONE_BIN" ] && [ -x "$HOME/bin/rclone" ] && RCLONE_BIN="$HOME/bin/rclone"
[ -z "$RCLONE_BIN" ] && RCLONE_BIN="rclone"
SAAS_BACKUP_DBS=(
    "cms"
    "notifuse"
    "prospection"
    "veridian-core"
)

saas_backup_r2_inventory() {
    "$RCLONE_BIN" lsf --recursive r2:veridian-backups/ 2>/dev/null \
        | awk -F/ 'NF > 1 { count[$1]++ } END { for (db in count) print db "=" count[db] }'
}

nomad_state_section() {
    local start="$1" stop="$2"
    awk -v start="$start" -v stop="$stop" '
        index($0, start) { visible=1; next }
        visible && index($0, stop) { exit }
        visible { print }
    '
}

###############################################################################
# §1 — GLOBAL INFRA : machines, services, Traefik routes, obs stack
###############################################################################

render_section_global() {
    echo "# §1 GLOBAL INFRA — $(date '+%Y-%m-%d %H:%M') — from ${HOSTNAME_SHORT}"
    echo ""

    # Kick off `obs check` in the background — slowest call (~15s).
    # Result file is consumed at the end of this section.
    local OBS_OUT_FILE=""
    if command -v obs >/dev/null 2>&1; then
        OBS_OUT_FILE="$(mktemp)"
        ( obs check 2>/dev/null | sed -n '1,15p' > "$OBS_OUT_FILE" 2>/dev/null ) &
    fi

    # Nomad est la source de vérité des routes, allocations, réservations et
    # snapshots cross-nœud. Le hook ne réimplémente plus ces contrôles depuis
    # les labels Docker ou d'anciens répertoires de sync.
    local NOMAD_STATE NOMAD_FREE NOMAD_STATE_FILE NOMAD_FREE_FILE NOMAD_STATE_PID NOMAD_FREE_PID
    NOMAD_STATE_FILE="$(mktemp)"
    NOMAD_FREE_FILE="$(mktemp)"
    ( timeout 20 "$NOMAD_V" state > "$NOMAD_STATE_FILE" 2>/dev/null || true ) &
    NOMAD_STATE_PID=$!
    ( timeout 12 "$NOMAD_V" free > "$NOMAD_FREE_FILE" 2>/dev/null || true ) &
    NOMAD_FREE_PID=$!

    case "$HOSTNAME_SHORT" in
        mail)
            echo "## LOCAL: Mail KDE (this machine)"
            echo "  $(local_resources)"
            echo "  Services: $(local_services 'docker' | tr '\n' ' ')"
            echo ""
            echo "## PROD: OVH VPS (100.88.202.29)"
            echo "  $(remote_resources 100.88.202.29)"
            echo "  Docker: $(remote_docker 100.88.202.29 | head -1)"
            remote_docker 100.88.202.29 | tail -n +2 | sed 's/^/  /'
            echo "  Services:"
            remote_services 100.88.202.29 "$SSH_KEY" ubuntu "veridian-docker-monitor veridian-system-monitor" | sed 's/^/    /'
            echo ""
            echo "## DEV: Dev Server (dev-pub → 37.187.199.185)"
            echo "  $(remote_resources --alias dev-pub)"
            echo "  Services:"
            remote_services --alias dev-pub "veridian-prod-healthcheck veridian-system-monitor" | sed 's/^/    /'
            ;;
        *)
            echo "## LOCAL: ${HOSTNAME_SHORT}"
            echo "  $(local_resources)"
            ;;
    esac

    wait "$NOMAD_STATE_PID" 2>/dev/null || true
    wait "$NOMAD_FREE_PID" 2>/dev/null || true
    NOMAD_STATE="$(cat "$NOMAD_STATE_FILE")"
    NOMAD_FREE="$(cat "$NOMAD_FREE_FILE")"
    rm -f "$NOMAD_STATE_FILE" "$NOMAD_FREE_FILE"

    echo ""
    echo "## Santé HTTP Nomad (routes PROD + STAGING live)"
    if [ -n "$NOMAD_STATE" ]; then
        printf '%s\n' "$NOMAD_STATE" | nomad_state_section "▓▓ SANTÉ HTTP" "▓▓ BACKUPS" | sed '/^[[:space:]]*$/d; s/^/  /'
    else
        echo "  ⚠ nomad-v state indisponible : état des routes inconnu"
    fi

    if [ -n "$OBS_OUT_FILE" ]; then
        echo ""
        echo "## Stack obs (Grafana Cloud — logs/metrics/traces)"
        wait
        if [ -s "$OBS_OUT_FILE" ]; then
            sed 's/^/  /' "$OBS_OUT_FILE"
        else
            echo "  (obs check ne répond pas — vérifier ~/.config/obs/)"
        fi
        rm -f "$OBS_OUT_FILE"
        # Aiguillage : ces trois outils existent et sont sous-utilisés parce que
        # rien ne signalait leur existence. Coroot notamment, deploye le 2026-08-18
        # en remplacement du cockpit maison, n'etait cite dans aucun hook.
        echo "  ─────"
        echo "  Creuser : erreurs/logs → obs check <topic>, obs errors, obs tail <container>"
        echo "            capacite/OOM/pics → obs-nomad capacite|gras|pic <job>|oom"
        echo "            carte des services et dependances → https://coroot.internal.veridian.site"
    fi

    echo ""
    echo "## Capacité Nomad (réservations scheduler vs usage réel)"
    if [ -n "$NOMAD_FREE" ]; then
        printf '%s\n' "$NOMAD_FREE" | sed '1d; s/^/  /'
    else
        echo "  ⚠ nomad-v free indisponible : capacité inconnue"
    fi

    echo ""
    echo "## Backups (snapshot cross-nœud all-cron + copie froide R2)"
    if [ -n "$NOMAD_STATE" ]; then
        printf '%s\n' "$NOMAD_STATE" | nomad_state_section "▓▓ BACKUPS" "▓▓ BACKLOG" | sed '/^[[:space:]]*$/d; s/^/  /'
    else
        echo "  ⚠ état du snapshot cross-nœud inconnu"
    fi
    local db r2_count r2_bad=0 r2_inventory
    r2_inventory="$(saas_backup_r2_inventory)"
    printf "  R2:"
    for db in "${SAAS_BACKUP_DBS[@]}"; do
        r2_count=$(printf '%s\n' "$r2_inventory" | awk -F= -v db="$db" '$1 == db { print $2; exit }')
        case "$r2_count" in ''|*[!0-9]*) r2_count=0 ;; esac
        [ "$r2_count" -ge 7 ] || r2_bad=1
        printf " %s=%s" "$db" "$r2_count"
    done
    [ "$r2_bad" = 0 ] && printf " ✓\n" || printf " ⚠ rétention <7\n"

    render_crons_failed
}

###############################################################################
# Tâches planifiées en échec — avec LEUR CAUSE, pas seulement leur nom.
#
# Pourquoi ça existe : le 28/08/2026, deux sauvegardes (les huit bases Medusa
# clientes, et ClickHouse qui porte l'analytics de tous les clients) étaient
# muettes depuis trois nuits. `all-cron status` les affichait en `fail`, et
# leurs journaux nommaient la cause en toutes lettres — « ssh: connection timed
# out », « nœud inconnu de la table d'alias ». Mais rien ne remontait au
# démarrage, et personne ne lance `all-cron status` chaque matin.
#
# Le nom d'un job en échec ne suffit pas à décider d'agir : c'est la cause qui
# fait la différence entre « une IP a bougé, deux minutes » et « à creuser ».
# D'où la dernière ligne du journal, affichée directement.
###############################################################################
render_crons_failed() {
    command -v systemctl >/dev/null 2>&1 || return 0
    local failed
    failed=$(timeout 5 systemctl --user list-units --type=service --state=failed --no-legend --plain 2>/dev/null \
             | awk '$1 ~ /^allcron-/ { print $1 }' | head -8)
    [ -n "$failed" ] || return 0

    echo ""
    echo "## 🔴 Tâches planifiées en échec"
    # Le nom d'unité est allcron-<dossier>-<job>, et le dossier contient lui-même
    # des tirets (`acquisition-emailing`). Le découper au premier tiret donne un
    # chemin faux et un « journal muet » trompeur : on cherche donc le fichier
    # dont <dossier>/<job> reconstitue exactement le nom de l'unité.
    local logs_root="$HOME/all-cron/_logs"
    local unit job log rel cause
    while IFS= read -r unit; do
        [ -n "$unit" ] || continue
        job="${unit#allcron-}"; job="${job%.service}"
        log=""
        while IFS= read -r f; do
            rel="${f#"$logs_root"/}"; rel="${rel%.log}"
            if [ "${rel/\//-}" = "$job" ]; then log="$f"; break; fi
        done < <(find "$logs_root" -maxdepth 2 -name '*.log' 2>/dev/null)
        cause=""
        [ -n "$log" ] && cause=$(tail -n 40 "$log" 2>/dev/null \
                                 | grep -vE '^──|OK container=|^[[:space:]]*$' \
                                 | tail -1 | cut -c1-104)
        printf '  ✗ %-46s %s\n' "${job:0:46}" "${cause:-(journal muet — systemctl --user status ${unit})}"
    done <<< "$failed"
    echo "  → réparer : all-cron logs <job> · relancer : systemctl --user start <unit>"
}

###############################################################################
# §2 — SAAS OVERVIEW : pipeline live + cross-repo compact summary
###############################################################################

render_pipeline_live() {
    local tmpdir; tmpdir="$(mktemp -d)"
    local i=0
    for r in "${SAAS_REPOS[@]}"; do
        (
            local out=""
            local running ap rb
            running=$(saas_running_ci "$r")
            if [ -n "$running" ]; then
                while IFS='|' read -r wf br at id ev; do
                    [ -z "$wf" ] && continue
                    local age; age=$(iso_to_age "$at")
                    out="${out}  ● ${r} → [${br}] ${wf} running ${age} (event:${ev}) → https://github.com/Christ-Roy/${r}/actions/runs/${id}\n"
                done <<< "$running"
            fi
            ap=$(saas_recent_autopromote "$r")
            if [ -n "$ap" ]; then
                local ap_at ap_msg ap_age
                ap_at="${ap#*|}"; ap_at="${ap_at%%|*}"
                ap_msg="${ap##*|}"
                ap_age=$(iso_to_age "$ap_at")
                out="${out}  🚀 ${r} → auto-promote il y a ${ap_age}: ${ap_msg:0:65}\n"
            fi
            rb=$(saas_recent_rollback "$r")
            if [ -n "$rb" ]; then
                local rb_at rb_msg rb_age
                rb_at="${rb#*|}"; rb_at="${rb_at%%|*}"
                rb_msg="${rb##*|}"
                rb_age=$(iso_to_age "$rb_at")
                out="${out}  🔴 ${r} → ROLLBACK il y a ${rb_age} (${rb_msg:0:50})\n"
            fi
            [ -n "$out" ] && printf "%b" "$out" > "${tmpdir}/${i}"
        ) &
        i=$((i+1))
    done
    wait
    local content=""
    for j in $(seq 0 $((i-1))); do
        [ -f "${tmpdir}/${j}" ] && content="${content}$(cat "${tmpdir}/${j}")
"
    done
    rm -rf "$tmpdir"
    if [ -n "$content" ]; then
        echo "## Pipeline LIVE (runs en cours / événements récents < 6h)"
        printf "%s" "$content"
    else
        echo "## Pipeline LIVE — rien en cours, aucun auto-promote ni rollback récent ✓"
    fi
}

render_repo_compact() {
    local r="$1"
    local d="$SAAS_ROOT/$r"
    [ ! -d "$d/.git" ] && { echo "  · ${r} (pas un git repo)"; return; }

    local br dirty
    br=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
    dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l)

    # staging↔main delta = signal #1 (à promote ou hotfix divergent)
    local stmain=""
    if git -C "$d" rev-parse --verify "origin/staging" >/dev/null 2>&1 \
       && git -C "$d" rev-parse --verify "origin/main" >/dev/null 2>&1; then
        local sm ms
        sm=$(git -C "$d" rev-list --count "origin/main..origin/staging" 2>/dev/null)
        ms=$(git -C "$d" rev-list --count "origin/staging..origin/main" 2>/dev/null)
        if [ "$sm" != 0 ] && [ "$ms" != 0 ]; then stmain=" stg↕main:↑${sm}↓${ms}⚠"
        elif [ "$ms" != 0 ]; then stmain=" main↑${ms}⚠hotfix"
        elif [ "$sm" != 0 ]; then stmain=" stg→main:${sm}"
        fi
    fi

    # CI per branch — n'afficher QUE si fail OU running (success = silence)
    local ci_data ci_alerts=""
    ci_data=$(gh run list --repo "Christ-Roy/${r}" --limit 15 --event push \
        --json conclusion,status,headBranch,createdAt \
        --jq '[.[] | {br: .headBranch, c: (.conclusion // .status), at: .createdAt}]
              | group_by(.br) | map(sort_by(.at) | reverse | .[0])
              | .[] | "\(.br)|\(.c)|\(.at)"' 2>/dev/null)
    while IFS='|' read -r br_n c_n at_n; do
        [ -z "$br_n" ] && continue
        local age_n; age_n=$(iso_to_age "$at_n")
        case "$c_n" in
            failure)               ci_alerts="${ci_alerts} ✗${br_n}:${age_n}" ;;
            in_progress|queued)    ci_alerts="${ci_alerts} ●${br_n}:${age_n}" ;;
        esac
    done <<< "$ci_data"

    # Drift image + lag — n'afficher QUE si drift OU lag (aligned = silence)
    local drift_alert=""
    if [ -n "$(saas_ghcr_pkg "$r")" ]; then
        local STG_INFO PRD_INFO stg_tag stg_sha prd_tag prd_sha tmp
        STG_INFO=$(saas_staging_image_info "$r")
        PRD_INFO=$(saas_prod_image_info "$r")
        stg_tag="${STG_INFO%%|*}"; tmp="${STG_INFO#*|}"; stg_sha="${tmp%%|*}"
        prd_tag="${PRD_INFO%%|*}"; tmp="${PRD_INFO#*|}"; prd_sha="${tmp%%|*}"
        if [ -n "$stg_sha" ] && [ "$stg_sha" != "?" ] && [ "$stg_sha" != "$prd_sha" ] && [ "$stg_tag" != "$prd_tag" ]; then
            if git -C "$d" merge-base --is-ancestor "$stg_sha" "origin/main" 2>/dev/null; then
                drift_alert=" ⏳prod-deploy"
            else
                drift_alert=" ⚠stg-ahead"
            fi
        fi
        # GHCR lag (image plus récente pas déployée) — signal moins critique
        local prd_lag; prd_lag=$(saas_image_lag "$r" "$prd_tag")
        [ -n "$prd_lag" ] && drift_alert="${drift_alert} 📦new"
    fi

    # PR count > 0 ou todo > 0 = signaux faibles, regroupés
    local pr_n; pr_n=$(gh pr list --repo "Christ-Roy/${r}" --json number 2>/dev/null | jq 'length' 2>/dev/null || echo 0)
    local todo_n; todo_n=$(ls "${d}/todo/" 2>/dev/null | grep -cE '\.md$')
    local backlog=""
    [ "${pr_n:-0}" -gt 0 ] && backlog="${backlog} PR:${pr_n}"
    [ "${todo_n:-0}" -gt 0 ] && backlog="${backlog} todo:${todo_n}"
    [ "$dirty" -gt 0 ] && backlog="${backlog} dirty:${dirty}"

    local policy_badge; policy_badge=$(saas_policy_badge "$(saas_promote_policy "$r")")

    # Guardrails (audit statique) — affiché seulement si pas ✓ trusted
    local gr; gr=$(saas_guardrails_audit "$r")
    local gr_status="${gr%%|*}"
    local gr_badge=""
    case "$gr_status" in
        "✓ trusted")        gr_badge="" ;;                      # silence quand OK
        "⚠ check-yourself") gr_badge=" 🔧check-husky" ;;
        "✗ broken")         gr_badge=" 🚨HUSKY-BROKEN" ;;
    esac

    # 1 ligne dense — branch, drift, CI alerts, image drift, backlog, guardrails
    printf "  %s %-22s [%s]%s%s%s%s%s\n" \
        "$policy_badge" "$r" "$br" "$stmain" "$ci_alerts" "$drift_alert" "$backlog" "$gr_badge"
}

render_section_saas_overview() {
    echo "# §2 SAAS OVERVIEW"
    echo ""

    for r in "${SAAS_REPOS[@]}"; do
        ( cd "$SAAS_ROOT/$r" 2>/dev/null && timeout 6 git fetch --quiet --no-tags origin 2>/dev/null ) &
    done
    wait

    render_pipeline_live
    echo ""
    echo "## Cross-repo summary (toutes les apps SaaS, vue compacte)"
    local tmpdir; tmpdir="$(mktemp -d)"
    local i=0
    for r in "${SAAS_REPOS[@]}"; do
        ( render_repo_compact "$r" > "${tmpdir}/${i}" ) &
        i=$((i+1))
    done
    wait
    for j in $(seq 0 $((i-1))); do
        [ -f "${tmpdir}/${j}" ] && cat "${tmpdir}/${j}"
    done
    rm -rf "$tmpdir"

    echo ""
    echo "  Légende (silence = OK, seuls les signaux actionnables sont affichés):"
    echo "    Policy:    🤖 auto-promote | ✋ manuel à câbler | 🔒 manuel critique | · n/a"
    echo "    stg→main:N N commits prêts à promote — main↑N⚠hotfix = main en avance (divergence)"
    echo "    ✗br:age    CI fail sur br (creuser dans §3 ou repo dédié)"
    echo "    ●br:age    CI running NOW"
    echo "    ⏳prod-deploy  staging déjà dans main, prod doit déployer"
    echo "    ⚠stg-ahead    staging EN AVANCE de prod (pas encore mergé dans main)"
    echo "    📦new          nouvelle image GHCR pas encore déployée"
    echo "    PR:N todo:N dirty:N  backlog / WIP local"
    echo "    🔧check-husky / 🚨HUSKY-BROKEN  audit pre-push échoué (cf §3 pour le détail repo courant)"
}

###############################################################################
# §3 — CURRENT REPO : photo détaillée du repo Claude est lancé dans
###############################################################################

render_section_current_repo() {
    local CURRENT_REPO; CURRENT_REPO="$(detect_current_saas_repo)"
    [ -z "$CURRENT_REPO" ] && {
        echo "# §3 CURRENT REPO — (Claude n'est pas dans un repo SaaS — section skip)"
        return
    }
    local REPO_DIR="$SAAS_ROOT/$CURRENT_REPO"
    echo "# §3 CURRENT REPO: ${CURRENT_REPO}"
    echo ""

    ( cd "$REPO_DIR" && timeout 8 git fetch --quiet --no-tags origin 2>/dev/null ) &
    local FETCH_PID=$!

    local BRANCH HEAD_SHA HEAD_MSG
    BRANCH=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
    HEAD_SHA=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null)
    HEAD_MSG=$(git -C "$REPO_DIR" log -1 --format='%s' 2>/dev/null)
    echo "  HEAD:    ${BRANCH} @ ${HEAD_SHA} — ${HEAD_MSG}"

    local POLICY; POLICY=$(saas_promote_policy "$CURRENT_REPO")
    echo "  Policy:  $(saas_policy_label "$POLICY")"

    # Guardrails — audit statique + dry-run réel du pre-push
    local GR; GR=$(saas_guardrails_audit "$CURRENT_REPO")
    local GR_STATUS="${GR%%|*}"
    local GR_DETAIL="${GR#*|}"
    case "$GR_STATUS" in
        "✓ trusted")
            echo "  Guards:  ✓ trusted (${GR_DETAIL}) — agent peut faire confiance à pre-push"
            ;;
        "⚠ check-yourself")
            echo "  Guards:  ⚠ check-yourself — anomalie statique:"
            echo "             ${GR_DETAIL}"
            echo "             → action: ouvrir .husky/pre-push + scripts/ci/ et vérifier toi-même"
            ;;
        "✗ broken")
            echo "  Guards:  🚨 BROKEN — pre-push ne protège PAS:"
            echo "             ${GR_DETAIL}"
            echo "             → action: REINSTALL husky (pnpm install) ou fix manuellement avant tout push"
            ;;
    esac
    # Dry-run réel — vraie exécution sandboxée pour voir si le pre-push bloquerait
    local DR; DR=$(saas_guardrails_dryrun "$CURRENT_REPO")
    local DR_STATUS="${DR%%|*}"
    local DR_MSG="${DR#*|}"
    case "$DR_STATUS" in
        "✓")    echo "  Dry-run: ✓ pre-push exécuté → laisserait passer (${DR_MSG})" ;;
        "✗")    echo "  Dry-run: ✗ pre-push BLOQUERAIT — ${DR_MSG}" ;;
        "?")    echo "  Dry-run: ? ${DR_MSG}" ;;
        "skip") echo "  Dry-run: — ${DR_MSG}" ;;
    esac
    echo ""

    local MOD STAGED UNTRACKED
    MOD=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | grep -cE '^[ MARCD][MD]')
    STAGED=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | grep -cE '^[MARCD]')
    UNTRACKED=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | grep -c '^??')
    if [ $((MOD + STAGED + UNTRACKED)) -gt 0 ]; then
        echo "  Working tree: ${STAGED} staged · ${MOD} modified · ${UNTRACKED} untracked"
        git -C "$REPO_DIR" status --short 2>/dev/null | head -10 | sed 's/^/    /'
        local extra; extra=$(( $(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l) - 10 ))
        [ "$extra" -gt 0 ] && echo "    … (+${extra} more)"
    else
        echo "  Working tree: clean ✓"
    fi
    echo ""

    wait $FETCH_PID 2>/dev/null

    if git -C "$REPO_DIR" rev-parse --verify "origin/${BRANCH}" >/dev/null 2>&1; then
        local AHEAD BEHIND
        AHEAD=$(git -C "$REPO_DIR" rev-list --count "origin/${BRANCH}..HEAD" 2>/dev/null)
        BEHIND=$(git -C "$REPO_DIR" rev-list --count "HEAD..origin/${BRANCH}" 2>/dev/null)
        if [ "$AHEAD" = "0" ] && [ "$BEHIND" = "0" ]; then
            echo "  vs origin/${BRANCH}: in sync ✓"
        else
            echo "  vs origin/${BRANCH}: ↑${AHEAD} ahead · ↓${BEHIND} behind"
            [ "$AHEAD" != "0" ] && git -C "$REPO_DIR" log --oneline "origin/${BRANCH}..HEAD" 2>/dev/null | head -5 | sed 's/^/    ↑ /'
            [ "$BEHIND" != "0" ] && git -C "$REPO_DIR" log --oneline "HEAD..origin/${BRANCH}" 2>/dev/null | head -5 | sed 's/^/    ↓ /'
        fi
        local DIFF_STAT; DIFF_STAT=$(git -C "$REPO_DIR" diff --shortstat "origin/${BRANCH}" 2>/dev/null)
        [ -n "$DIFF_STAT" ] && echo "  Uncommitted vs origin/${BRANCH}:${DIFF_STAT}"
    fi

    if git -C "$REPO_DIR" rev-parse --verify "origin/staging" >/dev/null 2>&1 \
       && git -C "$REPO_DIR" rev-parse --verify "origin/main" >/dev/null 2>&1; then
        local ST_AHEAD ST_BEHIND
        ST_AHEAD=$(git -C "$REPO_DIR" rev-list --count "origin/main..origin/staging" 2>/dev/null)
        ST_BEHIND=$(git -C "$REPO_DIR" rev-list --count "origin/staging..origin/main" 2>/dev/null)
        if [ "$ST_AHEAD" = "0" ] && [ "$ST_BEHIND" = "0" ]; then
            echo "  staging ↔ main: aligned ✓"
        else
            if [ "$ST_AHEAD" != "0" ]; then
                echo "  staging → main: ${ST_AHEAD} commits à promote ⚠"
                git -C "$REPO_DIR" log --oneline "origin/main..origin/staging" 2>/dev/null | head -5 | sed 's/^/    ⇒ /'
                [ "$ST_AHEAD" -gt 5 ] && echo "    … (+$((ST_AHEAD-5)) more)"
            fi
            [ "$ST_BEHIND" != "0" ] && echo "  staging ← main: ${ST_BEHIND} commits in main not in staging ⚠ (hotfix?)"
        fi
    fi
    echo ""

    echo "  CI status (last push run per workflow):"
    gh run list --repo "Christ-Roy/${CURRENT_REPO}" --limit 30 --event push \
        --json conclusion,status,headBranch,workflowName,createdAt,displayTitle,databaseId \
        --jq '[.[] | {br: .headBranch, c: (.conclusion // .status), at: .createdAt, wf: .workflowName, t: .displayTitle, id: .databaseId}]
              | group_by(.br + "|" + .wf) | map(sort_by(.at) | reverse | .[0])
              | sort_by(.br, .wf)
              | .[] | "\(.c)|\(.wf)|\(.br)|\(.at)|\(.t)|\(.id)"' 2>/dev/null \
    | while IFS='|' read -r concl wf branch created title rid; do
        local glyph age short_title url_str
        glyph=$(ci_glyph "$concl")
        age=$(iso_to_age "$created")
        short_title="${title:0:55}"
        [ "${#title}" -gt 55 ] && short_title="${short_title}…"
        url_str=""
        [ "$concl" = "failure" ] && url_str="  → https://github.com/Christ-Roy/${CURRENT_REPO}/actions/runs/${rid}"
        printf "    %s [%-9s] %-25s %4s ago — %s%s\n" "$glyph" "$branch" "$wf" "$age" "$short_title" "$url_str"
    done

    local RUNNING; RUNNING=$(saas_running_ci "$CURRENT_REPO")
    if [ -n "$RUNNING" ]; then
        echo "  ⚡ CI running NOW:"
        echo "$RUNNING" | while IFS='|' read -r wf br at id ev; do
            local age; age=$(iso_to_age "$at")
            printf "    ● [%-9s] %-25s %4s ago (event:%s) → https://github.com/Christ-Roy/%s/actions/runs/%s\n" \
                "$br" "$wf" "$age" "$ev" "$CURRENT_REPO" "$id"
        done
    fi

    local AP; AP=$(saas_recent_autopromote "$CURRENT_REPO")
    if [ -n "$AP" ]; then
        local AP_AT AP_MSG AP_AGE
        AP_AT="${AP#*|}"; AP_AT="${AP_AT%%|*}"
        AP_MSG="${AP##*|}"
        AP_AGE=$(iso_to_age "$AP_AT")
        echo "  🚀 Auto-promote détecté il y a ${AP_AGE}: ${AP_MSG:0:60}"
    fi
    local RB; RB=$(saas_recent_rollback "$CURRENT_REPO")
    if [ -n "$RB" ]; then
        local RB_AT RB_MSG RB_AGE
        RB_AT="${RB#*|}"; RB_AT="${RB_AT%%|*}"
        RB_MSG="${RB##*|}"
        RB_AGE=$(iso_to_age "$RB_AT")
        echo "  🔴 ROLLBACK détecté il y a ${RB_AGE} (${RB_MSG:0:50})"
    fi

    echo ""
    local PR_COUNT; PR_COUNT=$(gh pr list --repo "Christ-Roy/${CURRENT_REPO}" --json number 2>/dev/null | jq 'length' 2>/dev/null)
    if [ "${PR_COUNT:-0}" -gt 0 ]; then
        echo "  Open PRs (${PR_COUNT}):"
        gh pr list --repo "Christ-Roy/${CURRENT_REPO}" --limit 8 \
            --json number,title,headRefName,createdAt,statusCheckRollup,isDraft \
            --jq '.[] | "    #\(.number)|\(.headRefName)|\(.title)|\(.createdAt)|\(.isDraft)|\([.statusCheckRollup[] | .conclusion // .status] | unique | join(","))"' 2>/dev/null \
        | while IFS='|' read -r num branch title created draft checks; do
            local age short_title draft_mark
            age=$(iso_to_age "$created")
            draft_mark=""
            [ "$draft" = "true" ] && draft_mark=" [DRAFT]"
            short_title="${title:0:50}"
            [ "${#title}" -gt 50 ] && short_title="${short_title}…"
            printf "    %s [%s]%s — %s (%s ago) — checks: %s\n" "$num" "$branch" "$draft_mark" "$short_title" "$age" "${checks:-pending}"
        done
    else
        echo "  Open PRs: none ✓"
    fi

    if [ -n "$(saas_ghcr_pkg "$CURRENT_REPO")" ]; then
        echo ""
        echo "  Deployed images:"
        local STG_INFO PRD_INFO STG_TAG STG_SHA STG_AGE PRD_TAG PRD_SHA PRD_AGE rest
        STG_INFO=$(saas_staging_image_info "$CURRENT_REPO")
        PRD_INFO=$(saas_prod_image_info "$CURRENT_REPO")
        STG_TAG="${STG_INFO%%|*}"; rest="${STG_INFO#*|}"; STG_SHA="${rest%%|*}"; STG_AGE="${rest##*|}"
        PRD_TAG="${PRD_INFO%%|*}"; rest="${PRD_INFO#*|}"; PRD_SHA="${rest%%|*}"; PRD_AGE="${rest##*|}"
        printf "    %-9s %-35s git:%-8s up:%s\n" "staging:" "$STG_TAG" "$STG_SHA" "$STG_AGE"
        printf "    %-9s %-35s git:%-8s up:%s\n" "prod:"    "$PRD_TAG" "$PRD_SHA" "$PRD_AGE"
        local STG_LAG PRD_LAG
        STG_LAG=$(saas_image_lag "$CURRENT_REPO" "$STG_TAG")
        PRD_LAG=$(saas_image_lag "$CURRENT_REPO" "$PRD_TAG")
        [ -n "$STG_LAG" ] && echo "    ⏳ staging derrière GHCR — latest: ${STG_LAG}"
        [ -n "$PRD_LAG" ] && echo "    ⏳ prod    derrière GHCR — latest: ${PRD_LAG}"
        if [ -n "$STG_SHA" ] && [ "$STG_SHA" != "?" ] && [ "$STG_SHA" != "$PRD_SHA" ]; then
            if git -C "$REPO_DIR" merge-base --is-ancestor "$STG_SHA" "origin/main" 2>/dev/null; then
                echo "    ⏳ staging déjà dans main, prod doit déployer"
            else
                echo "    ⚠  staging EN AVANCE de prod (${STG_SHA} pas dans main)"
            fi
        elif [ "$STG_TAG" = "$PRD_TAG" ] && [ -n "$STG_TAG" ]; then
            echo "    ✓ staging et prod alignées"
        fi
    fi

    local TODO_COUNT DONE_COUNT
    TODO_COUNT=$(ls "${REPO_DIR}/todo/" 2>/dev/null | grep -cE '\.md$')
    DONE_COUNT=$(ls "${REPO_DIR}/done/" 2>/dev/null | grep -cE '\.md$')
    if [ "$TODO_COUNT" -gt 0 ] || [ "$DONE_COUNT" -gt 0 ]; then
        echo ""
        echo "  todo/: ${TODO_COUNT} pending · done/: ${DONE_COUNT} archived"
        [ "$TODO_COUNT" -gt 0 ] && ls "${REPO_DIR}/todo/" 2>/dev/null | grep -E '\.md$' | head -6 | sed 's/^/    • /'
        [ "$TODO_COUNT" -gt 6 ] && echo "    … (+$((TODO_COUNT-6)) more)"
    fi
}

###############################################################################
# Fusibles API réseaux sociaux : coupures volontaires en cours
#
# Un fusible pose a la main est invisible tant qu'on ne va pas le chercher.
# S'il traine, on croit que l'integration est cassee alors qu'elle est en pause.
#
# 🔴 CE BLOC RESTE MESURÉ À L'AFFICHAGE, PAS DÉPOSÉ. C'est une lecture de
# fichiers locaux, mesurée à 0,0 s le 2026-09-14 : la déposer ne gagnerait rien
# et ferait afficher un fusible périmé jusqu'à une heure. Un fusible qu'on vient
# de poser doit se voir à la session suivante, pas au prochain relevé.
###############################################################################
render_social_api_pauses() {
    local any=0
    for flag in "$HOME"/credentials/social/*-EN-PAUSE; do
        [ -e "$flag" ] || continue
        if [ "$any" -eq 0 ]; then
            echo ""
            echo ""
            echo "# 🔴 API SOCIALES EN PAUSE (fusible pose volontairement)"
            any=1
        fi
        local nom; nom=$(basename "$flag" | sed 's/-EN-PAUSE//')
        local depuis; depuis=$(date -r "$flag" '+%Y-%m-%d %H:%M' 2>/dev/null)
        echo "  ⛔ ${nom} — depuis ${depuis}"
        sed -n '3,6p' "$flag" 2>/dev/null | sed 's/^/     /'
        echo "     état complet : ~/réseaux/tiktok/ETAT.md"
        echo "     lever le fusible : rm ${flag}"
    done
}

# --- Crypto : constantes établies + verdict gas du jour — non bloquant ---
render_crypto() {
    echo ""
    echo ""
    echo "# CRYPTO — constantes à garder en tête (détail : crypto facts)"
    if [ -x "$HOME/.local/bin/crypto" ]; then
        "$HOME/.local/bin/crypto" facts --line 2>/dev/null
        timeout 8 "$HOME/.local/bin/crypto" gas --line 2>/dev/null || echo "  ⛽ gas indisponible (réseau) — lancer 'crypto gas' plus tard"
    else
        echo "  (CLI crypto absent)"
    fi
}

###############################################################################
# RELEVÉ / DÉPÔT — pourquoi ce hook ne mesure plus rien au démarrage
#
# CE QUE ÇA COÛTAIT. Ce hook est câblé en SessionStart. Il interroge la flotte
# en ssh, GHCR et l'API GitHub, Nomad, R2 et joue un dry-run de pre-push :
# 64,8 s · 63,5 s · 88,0 s sur trois relevés isolés le 2026-09-14, pour 167
# lignes. Il y a eu 505 sessions en 7 jours sur cette machine. Environ dix
# heures par semaine passées à regarder un curseur, sur le poste de travail
# principal de la flotte. L'en-tête d'origine disait « pas de cache : Robert
# remplit sa queue de messages pendant que le hook tourne, donc la latence n'est
# pas bloquante ». C'était faux : elle l'est, et elle l'est 72 fois par jour.
#
# LE MOTIF, DÉJÀ PROUVÉ DEUX FOIS SUR CETTE MACHINE. `verifier-contexte.sh` et
# `outillage.sh` séparent le RELEVÉ (lent, distant, à part) de l'AFFICHAGE
# (local, instantané, il lit un dépôt). Ce script fait désormais pareil.
#
# POURQUOI DEUX DÉPÔTS ET PAS UN. §1 et §2 ne dépendent pas du répertoire
# courant ; §3 décrit le repo dans lequel la session est lancée. Un dépôt unique
# afficherait le §3 d'un autre repo, ce qui est pire qu'une absence : c'est un
# faux vert sur le mauvais dépôt. D'où un dépôt global et un dépôt par repo.
#
# PAS DE TÂCHE PLANIFIÉE. Le rafraîchissement est porté par l'affichage
# lui-même : quand un dépôt dépasse son seuil d'âge, un relevé part EN FOND
# (setsid, jamais bloquant) et le dépôt existant est affiché avec son âge. Un
# verrou par dépôt empêche dix sessions simultanées de lancer dix relevés.
#
# 🔴 TROIS ÉTATS, JAMAIS DEUX. Un dépôt absent ou vide n'affiche pas un blanc et
# surtout pas un vert : il dit MESURE NON ABOUTIE et lance le relevé. Un relevé
# qui échoue écrit son échec, il n'efface pas le dépôt précédent. Un tableau de
# bord d'infra qui se tait parce qu'il n'a pas pu mesurer est exactement le
# piège que tout ce parc combat.
#
# USAGE
#   infra-status.sh                  lit les dépôts, n'exécute rien (c'est le hook)
#   infra-status.sh --afficher       idem, explicite
#   infra-status.sh --relever        relève tout (global + repo courant), en direct
#   infra-status.sh --relever-global §1 + §2 + crypto
#   infra-status.sh --relever-repo   §3 pour le repo du répertoire courant
#   infra-status.sh --direct         ancien comportement : tout mesurer, tout afficher,
#                                    sans toucher aux dépôts (debug / vérification)
#   infra-status.sh --epreuve        se voir rendre MESURE NON ABOUTIE puis reverdir
#
# CODES DE SORTIE du relevé : 0 déposé · 2 le relevé n'a rien produit.
###############################################################################

DEPOT_DIR="${INFRA_STATUS_DEPOT_DIR:-$HOME/.claude/infra-status}"
DEPOT_GLOBAL="$DEPOT_DIR/global.txt"
DEPOT_CRYPTO="$DEPOT_DIR/crypto.txt"
GLOBAL_AGE_MAX_MIN="${INFRA_STATUS_GLOBAL_AGE_MIN:-60}"
REPO_AGE_MAX_MIN="${INFRA_STATUS_REPO_AGE_MIN:-30}"
VERROU_MORT_S="${INFRA_STATUS_VERROU_MORT_S:-900}"

# Clé du dépôt §3 : le repo SaaS courant, ou rien si la session n'est pas dans
# un repo SaaS (dans ce cas §3 est instantané et se rend en direct).
depot_repo_courant() {
    local r; r="$(detect_current_saas_repo)"
    [ -n "$r" ] && printf '%s/repo-%s.txt' "$DEPOT_DIR" "$r"
}

age_minutes() {
    local f="$1" t
    t=$(stat -c %Y "$f" 2>/dev/null) || { echo 999999; return; }
    echo $(( ( $(date +%s) - t ) / 60 ))
}

age_lisible() {
    local m="$1"
    if [ "$m" -lt 60 ]; then printf '%s min' "$m"; return; fi
    if [ "$m" -lt 2880 ]; then
        if [ $((m%60)) -eq 0 ]; then printf '%s h' "$((m/60))"
        else printf '%s h %s min' "$((m/60))" "$((m%60))"; fi
        return
    fi
    printf '%s j' "$((m/1440))"
}

# Un verrou vivant veut dire « un relevé tourne » ; un verrou de plus de 15 min
# est un relevé mort, pas un relevé en cours.
verrou_pris() {
    local v="$1"
    if mkdir "$v" 2>/dev/null; then return 0; fi
    local age=$(( $(date +%s) - $(stat -c %Y "$v" 2>/dev/null || echo 0) ))
    if [ "$age" -gt "$VERROU_MORT_S" ]; then
        rmdir "$v" 2>/dev/null && mkdir "$v" 2>/dev/null && return 0
    fi
    return 1
}

verrou_vivant() {
    local v="$1"
    [ -d "$v" ] || return 1
    local age=$(( $(date +%s) - $(stat -c %Y "$v" 2>/dev/null || echo 0) ))
    [ "$age" -lt "$VERROU_MORT_S" ]
}

# Le relevé n'écrase jamais un dépôt par du vide : il écrit à côté, vérifie
# qu'il a produit quelque chose, et bascule d'un seul mv. Une coupure en cours
# de route laisse donc le dépôt précédent intact, daté, honnête.
deposer() {
    local cible="$1" tmp="$1.tmp.$$"
    cat > "$tmp"
    if [ -s "$tmp" ]; then
        mv "$tmp" "$cible"
        return 0
    fi
    rm -f "$tmp"
    return 2
}

relever_global() {
    mkdir -p "$DEPOT_DIR"
    local verrou="$DEPOT_GLOBAL.verrou"
    verrou_pris "$verrou" || { echo "relevé global déjà en cours" >&2; return 3; }
    trap 'rmdir "$verrou" 2>/dev/null' EXIT
    local debut; debut=$(date +%s)
    local rc=0
    { render_section_global; echo ""; echo ""; render_section_saas_overview; } | deposer "$DEPOT_GLOBAL" || rc=2
    render_crypto | deposer "$DEPOT_CRYPTO" || rc=2
    if [ "$rc" != 0 ]; then
        # Le relevé n'a rien produit. On le DIT, sans toucher au dépôt : un
        # dépôt vieux et daté vaut mieux qu'un dépôt effacé.
        printf '%s|%s\n' "$(date '+%Y-%m-%d %H:%M')" "le relevé global n'a produit aucune sortie" \
            > "$DEPOT_DIR/global.echec"
    else
        rm -f "$DEPOT_DIR/global.echec"
    fi
    rmdir "$verrou" 2>/dev/null; trap - EXIT
    [ "$rc" = 0 ] && echo "relevé global déposé en $(( $(date +%s) - debut ))s" >&2
    return $rc
}

relever_repo() {
    local cible; cible="$(depot_repo_courant)"
    [ -n "$cible" ] || { echo "pas dans un repo SaaS : rien à relever" >&2; return 0; }
    mkdir -p "$DEPOT_DIR"
    local verrou="$cible.verrou"
    verrou_pris "$verrou" || { echo "relevé repo déjà en cours" >&2; return 3; }
    trap 'rmdir "$verrou" 2>/dev/null' EXIT
    local debut; debut=$(date +%s)
    local rc=0
    render_section_current_repo | deposer "$cible" || rc=2
    rmdir "$verrou" 2>/dev/null; trap - EXIT
    [ "$rc" = 0 ] && echo "relevé §3 déposé en $(( $(date +%s) - debut ))s" >&2
    return $rc
}

# Relance non bloquante. `setsid` détache du terminal de la session : le hook
# rend la main immédiatement, le relevé survit à la fermeture de la session.
#
# INFRA_STATUS_RELANCE_SIMULEE=1 remplace le lancement par une trace. C'est le
# levier qui permet à l'épreuve de vérifier QUE la relance est demandée, sans
# déclencher 70 s de ssh à chaque fois qu'on éprouve le hook.
relancer_en_fond() {
    local quoi="$1" verrou="$2"
    verrou_vivant "$verrou" && return 0
    if [ "${INFRA_STATUS_RELANCE_SIMULEE:-0}" = "1" ]; then
        echo "[relance SIMULÉE: $quoi]" >&2
        return 0
    fi
    setsid nohup "$0" "$quoi" >/dev/null 2>&1 < /dev/null &
    disown 2>/dev/null || true
}

# Rend une section depuis son dépôt, avec les trois états.
afficher_depot() {
    local fichier="$1" seuil="$2" quoi="$3" titre="$4"
    local verrou="$fichier.verrou"
    if [ ! -s "$fichier" ]; then
        echo "# ⚠️ ${titre} — MESURE NON ABOUTIE : aucun relevé déposé"
        echo "   Ce n'est PAS « rien à signaler » : personne n'a encore mesuré cette section."
        if verrou_vivant "$verrou"; then
            echo "   Un relevé tourne en ce moment. Revenir à la session suivante, ou : $0 ${quoi}"
        else
            echo "   Relevé lancé en fond. Pour l'avoir tout de suite : $0 ${quoi}"
            relancer_en_fond "$quoi" "$verrou"
        fi
        return 0
    fi
    cat "$fichier"
    local m; m=$(age_minutes "$fichier")
    # L'age est TOUJOURS visible des qu'il depasse deux minutes. Sans ca, un
    # §3 depose il y a vingt minutes se lit comme l'etat du dossier a
    # l'instant, et un agent conclut sur un arbre de travail deja change.
    if [ "$m" -ge "$seuil" ]; then
        if verrou_vivant "$verrou"; then
            echo "  ⚠ relevé vieux de $(age_lisible "$m") — il décrit le passé. Un rafraîchissement tourne déjà."
        else
            echo "  ⚠ relevé vieux de $(age_lisible "$m") — il décrit le passé. Rafraîchissement lancé en fond."
            relancer_en_fond "$quoi" "$verrou"
        fi
    elif [ "$m" -ge 2 ]; then
        echo "  ↳ releve d'il y a $(age_lisible "$m") (rafraichi au-dela de ${seuil} min · tout de suite : $0 ${quoi})"
    fi
}

afficher() {
    local depot_repo; depot_repo="$(depot_repo_courant)"

    afficher_depot "$DEPOT_GLOBAL" "$GLOBAL_AGE_MAX_MIN" --relever-global "§1 GLOBAL INFRA + §2 SAAS OVERVIEW"
    if [ -s "$DEPOT_DIR/global.echec" ]; then
        echo "  🔴 dernier relevé global EN ÉCHEC ($(cut -d'|' -f1 "$DEPOT_DIR/global.echec")) : $(cut -d'|' -f2 "$DEPOT_DIR/global.echec")"
        echo "     ce qui est affiché ci-dessus est ANTÉRIEUR à cet échec — relancer : $0 --relever-global"
    fi

    echo ""
    echo ""
    if [ -n "$depot_repo" ]; then
        afficher_depot "$depot_repo" "$REPO_AGE_MAX_MIN" --relever-repo "§3 CURRENT REPO"
    else
        # Hors repo SaaS, §3 est une seule ligne et ne coûte rien : direct.
        render_section_current_repo
    fi

    render_social_api_pauses

    if [ -s "$DEPOT_CRYPTO" ]; then
        cat "$DEPOT_CRYPTO"
    else
        echo ""
        echo ""
        echo "# ⚠️ CRYPTO — MESURE NON ABOUTIE : aucun relevé déposé (lancer : crypto facts)"
    fi
}

# L'ancien comportement, intact : tout mesurer, tout afficher, ne rien déposer.
direct() {
    render_section_global
    echo ""
    echo ""
    render_section_saas_overview
    echo ""
    echo ""
    render_section_current_repo
    render_social_api_pauses
    render_crypto
}

###############################################################################
# L'ÉPREUVE — se voir rendre MESURE NON ABOUTIE, puis reverdir.
# Un contrôle qu'on n'a jamais vu se déclencher est une intention, pas une
# mesure. Elle travaille dans un dépôt jetable : les vrais dépôts ne bougent pas.
###############################################################################
epreuve() {
    local bac; bac=$(mktemp -d) || return 2
    local verdict=0
    # Aucune épreuve ne doit déclencher 70 s de ssh : la relance est simulée et
    # tracée, ce qui permet en plus de VÉRIFIER qu'elle est bien demandée.
    export INFRA_STATUS_RELANCE_SIMULEE=1

    echo "── ÉPREUVE 1/5 : dépôt ABSENT → MESURE NON ABOUTIE + relance demandée, jamais un blanc"
    local out1 err1
    err1=$(INFRA_STATUS_DEPOT_DIR="$bac/vide" "$0" --afficher 2>&1 >"$bac/o1")
    out1=$(cat "$bac/o1")
    sed 's/^/    /' <<<"$out1" | head -6
    grep -q 'MESURE NON ABOUTIE' <<<"$out1" || { echo "✗ ÉPREUVE RATÉE : dépôt absent n'a pas rendu MESURE NON ABOUTIE"; verdict=1; }
    [ -n "$out1" ] || { echo "✗ ÉPREUVE RATÉE : sortie vide sur dépôt absent"; verdict=1; }
    grep -q 'relance SIMULÉE: --relever-global' <<<"$err1" || { echo "✗ ÉPREUVE RATÉE : aucun relevé relancé sur dépôt absent"; verdict=1; }
    echo "    relance demandée : $(tr '\n' ' ' <<<"$err1")"

    echo "── ÉPREUVE 2/5 : dépôt PRÉSENT et frais → rend son contenu, sans avertissement d'âge ni relance"
    mkdir -p "$bac/frais"
    echo "# §1 CONTENU-TEMOIN-FRAIS" > "$bac/frais/global.txt"
    echo "# CRYPTO temoin"          > "$bac/frais/crypto.txt"
    local out2 err2
    err2=$(INFRA_STATUS_DEPOT_DIR="$bac/frais" "$0" --afficher 2>&1 >"$bac/o2")
    out2=$(cat "$bac/o2")
    grep -q 'CONTENU-TEMOIN-FRAIS' <<<"$out2" || { echo "✗ ÉPREUVE RATÉE : le contenu du dépôt n'a pas été rendu"; verdict=1; }
    grep -q 'relevé vieux de' <<<"$out2" && { echo "✗ ÉPREUVE RATÉE : un dépôt frais a été déclaré vieux"; verdict=1; }
    grep -q 'relance SIMULÉE: --relever-global' <<<"$err2" && { echo "✗ ÉPREUVE RATÉE : relevé global relancé alors que le dépôt est frais"; verdict=1; }
    echo "    contenu rendu, aucun avertissement d'âge, aucune relance globale ✓"

    echo "── ÉPREUVE 3/5 : dépôt VIEUX → rend son contenu ET dit son âge ET relance"
    mkdir -p "$bac/vieux"
    echo "# §1 CONTENU-TEMOIN-VIEUX" > "$bac/vieux/global.txt"
    echo "# CRYPTO temoin"           > "$bac/vieux/crypto.txt"
    touch -d '9 hours ago' "$bac/vieux/global.txt"
    local out3 err3
    err3=$(INFRA_STATUS_DEPOT_DIR="$bac/vieux" "$0" --afficher 2>&1 >"$bac/o3")
    out3=$(cat "$bac/o3")
    grep -q 'CONTENU-TEMOIN-VIEUX' <<<"$out3" || { echo "✗ ÉPREUVE RATÉE : contenu d'un dépôt vieux non rendu"; verdict=1; }
    grep -q 'relevé vieux de 9 h' <<<"$out3" || { echo "✗ ÉPREUVE RATÉE : l'âge (9 h) n'a pas été annoncé"; verdict=1; }
    grep -q 'relance SIMULÉE: --relever-global' <<<"$err3" || { echo "✗ ÉPREUVE RATÉE : dépôt périmé non rafraîchi"; verdict=1; }
    sed -n '/relevé vieux/p' <<<"$out3" | sed 's/^/    /'

    echo "── ÉPREUVE 4/5 : dépôt VIDE (fichier de 0 octet) → NON ABOUTIE, jamais un vert silencieux"
    mkdir -p "$bac/zero"; : > "$bac/zero/global.txt"; : > "$bac/zero/crypto.txt"
    local out4; out4=$(INFRA_STATUS_DEPOT_DIR="$bac/zero" "$0" --afficher 2>/dev/null)
    grep -q 'MESURE NON ABOUTIE' <<<"$out4" || { echo "✗ ÉPREUVE RATÉE : un fichier vide est passé pour une mesure"; verdict=1; }
    echo "    fichier de 0 octet correctement refusé ✓"

    echo "── ÉPREUVE 5/5 : un VERROU VIVANT ne doit pas déclencher une seconde relance"
    mkdir -p "$bac/verrouille/global.txt.verrou"
    local err5; err5=$(INFRA_STATUS_DEPOT_DIR="$bac/verrouille" "$0" --afficher 2>&1 >/dev/null)
    grep -q 'relance SIMULÉE: --relever-global' <<<"$err5" && { echo "✗ ÉPREUVE RATÉE : relevé relancé malgré un verrou vivant"; verdict=1; }
    echo "    verrou respecté, pas de tempête de relevés ✓"

    # `deposer` ne doit jamais remplacer un dépôt par du vide.
    echo "── BONUS : un relevé sans sortie ne doit PAS effacer le dépôt précédent"
    echo "ANCIEN" > "$bac/depose.txt"
    printf '' | deposer "$bac/depose.txt" && { echo "✗ ÉPREUVE RATÉE : deposer a accepté du vide"; verdict=1; }
    grep -qx 'ANCIEN' "$bac/depose.txt" || { echo "✗ ÉPREUVE RATÉE : le dépôt précédent a été détruit"; verdict=1; }
    echo "    dépôt précédent préservé ✓"

    rm -rf "$bac"
    [ $verdict -eq 0 ] && echo "✓ ÉPREUVE TENUE : vu rendre MESURE NON ABOUTIE sur dépôt absent et sur dépôt vide, vu annoncer l'âge d'un dépôt périmé, vu refuser d'écraser par du vide."
    return $verdict
}

case "${1:---afficher}" in
    --afficher)        afficher ;;
    --relever)         relever_global; relever_repo ;;
    --relever-global)  relever_global ;;
    --relever-repo)    relever_repo ;;
    --direct)          direct ;;
    --epreuve)         epreuve ;;
    -h|--help)         sed -n '/^# *USAGE/,/^# *CODES DE SORTIE/p' "$0" | sed 's/^# \{0,1\}//' ;;
    *)                 afficher ;;
esac
exit 0
