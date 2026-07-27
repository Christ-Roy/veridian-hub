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

remote_traefik_routes() {
    local ssh_cmd
    if [ "$1" = "--alias" ]; then
        ssh_cmd="timeout $SSH_TIMEOUT ssh -o ConnectTimeout=5 -o BatchMode=yes $2"
    else
        local host="$1" key="${2:-$SSH_KEY}" user="${3:-ubuntu}"
        ssh_cmd="timeout $SSH_TIMEOUT ssh -i $key -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${user}@${host}"
    fi
    $ssh_cmd '
        docker ps --format "{{.Names}}" | while read name; do
            host=$(docker inspect "$name" --format "{{range .Config.Labels}}{{println .}}{{end}}" 2>/dev/null | grep -oP "Host\(\`\K[^\`]+" | head -1)
            if [ -z "$host" ]; then continue; fi
            health=$(docker inspect "$name" --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}" 2>/dev/null)
            echo "${host}|${name}|${health}"
        done | sort -u
    ' 2>/dev/null
}

format_traefik_routes() {
    local lines; lines="$(cat)"
    [ -z "$lines" ] && { echo "  (aucune route détectée)"; return; }
    local maxw=0 w
    while IFS="|" read -r host _ _; do
        w=${#host}
        [ "$w" -gt "$maxw" ] && maxw=$w
    done <<< "$lines"
    local tmpdir; tmpdir="$(mktemp -d)"
    local i=0
    while IFS="|" read -r host name health; do
        (
            code="$(curl -s -k -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "https://${host}" 2>/dev/null)" || code="000"
            if [[ "$code" =~ ^[23] ]] || [[ "$code" == "401" ]] || [[ "$code" == "403" ]]; then mark="✓"
            elif [[ "$code" =~ ^4 ]]; then mark="?"
            else mark="✗"; fi
            printf "  %-${maxw}s  [%s] → %s %s\n" "$host" "$health" "$code" "$mark" > "${tmpdir}/${i}"
        ) &
        i=$((i+1))
    done <<< "$lines"
    wait
    for j in $(seq 0 $((i-1))); do
        [ -f "${tmpdir}/${j}" ] && cat "${tmpdir}/${j}"
    done
    rm -rf "$tmpdir"
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

# ─── Container resources (politique fusible 60% VM) ──────────────────────────
# Récupère l'état mémoire/CPU des containers prod + détecte ceux sans fusible.
#
# Politique Veridian (décision Robert 2026-05-19) :
#   Chaque container app doit avoir un mem_limit >= 60% de la RAM VM,
#   pour qu'une fuite dans une app tue cette app seule (OOM-killer) sans
#   prendre toute la stack. Les containers sans limite (mem_limit=0) sont
#   un risque cascade.
#
# Output: lignes "container|mem_used_mb|mem_limit_mb|mem_pct|cpu_pct|status"
# status = OK | WARN_HIGH (>80% lim) | NO_FUSE (mem_limit=0) | TOO_LOW (<60% VM)
saas_container_resources() {
    timeout "$SSH_TIMEOUT" ssh -i "$SSH_KEY" -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes \
        "ubuntu@100.88.202.29" '
        # VM total RAM (bytes) — seuil 55% pour tolérer les variations
        # docker-compose mem_limit: 6600m = 6.291 GiB ≈ 6604 MB → safe vs 60% des 12.24 GB VM = 7.34 GB
        # 55% = 6.73 GB → tolérance suffisante pour considérer 6600m comme conforme.
        vm_ram_bytes=$(free -b | awk "/^Mem/ {print \$2}")
        threshold_60=$(( vm_ram_bytes * 55 / 100 ))
        # Use docker stats once + inspect for limits
        docker stats --no-stream --format "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}" 2>/dev/null | \
        while IFS="|" read -r name mem_usage cpu_pct; do
            [ -z "$name" ] && continue
            # MemUsage = "33.14MiB / 6.5GiB" — parse used
            used_str=$(echo "$mem_usage" | awk -F" / " "{print \$1}")
            used_mb=$(echo "$used_str" | awk "{
                v=\$0; sub(/[A-Za-z]+$/,\"\",v);
                u=\$0; sub(/^[0-9.]+/,\"\",u);
                if (u==\"GiB\") printf \"%d\", v*1024
                else if (u==\"MiB\") printf \"%d\", v
                else if (u==\"KiB\") printf \"%d\", v/1024
                else printf \"%d\", v
            }")
            # mem_limit from inspect
            lim_bytes=$(docker inspect "$name" --format "{{.HostConfig.Memory}}" 2>/dev/null)
            if [ "$lim_bytes" = "0" ] || [ -z "$lim_bytes" ]; then
                lim_mb=0
                status="NO_FUSE"
            else
                lim_mb=$(( lim_bytes / 1024 / 1024 ))
                if [ "$lim_bytes" -lt "$threshold_60" ]; then
                    status="TOO_LOW"
                else
                    # Usage actuel vs limite
                    pct=$(( used_mb * 100 / lim_mb ))
                    if [ "$pct" -gt 80 ]; then status="WARN_HIGH"
                    else status="OK"; fi
                fi
            fi
            cpu_clean=$(echo "$cpu_pct" | tr -d "%")
            echo "${name}|${used_mb}|${lim_mb}|${cpu_clean}|${status}"
        done
    ' 2>/dev/null
}

# ─── Backups DB (R2 → local sync) ────────────────────────────────────────────
# 2026-07-27 : rclone vit dans ~/bin, qui n'est PAS dans le PATH quand ce hook
# tourne au SessionStart. Resultat : chaque appel rclone echouait en silence, le
# comptage tombait a 0 et le tableau de bord annoncait « AUCUN DUMP » sur les 4
# bases alors que R2 contenait bien 10 dumps par base. Un indicateur qui crie au
# loup finit par masquer une vraie panne : on resout le binaire explicitement.
RCLONE_BIN="$(command -v rclone 2>/dev/null || true)"
[ -z "$RCLONE_BIN" ] && [ -x "$HOME/bin/rclone" ] && RCLONE_BIN="$HOME/bin/rclone"
[ -z "$RCLONE_BIN" ] && RCLONE_BIN="rclone"   # dernier recours : message d'erreur explicite
# DBs surveillées et leur container prod / fréquence attendue
# Source de vérité : /etc/cron.d/veridian-backups + /etc/cron.d/cms-backup
# NB : verger-shop retiré 2026-07-01 — sa DB a migré sur Neon (serverless,
# backups/PITR gérés par Neon) le 2026-06-27, cron local commenté (MIGRÉ EDGE
# CLOUD). Plus de backup Docker local à surveiller → l'alerte "CRON DOWN" était
# un faux positif. Les 30 dumps R2 historiques restent (archive, non purgés).
SAAS_BACKUP_DBS=(
    "cms"
    "notifuse"
    "prospection"
    "veridian-core"
)

# Backups locaux (sync depuis R2 quotidien 07:00 via crontab brunon5@mail)
BACKUP_LOCAL_DIR="/home/brunon5/backups/veridian"

# Age d'un dump local (en heures) — basé sur mtime du fichier le plus récent
saas_backup_local_age_h() {
    local db="$1"
    local last; last=$(ls -t "${BACKUP_LOCAL_DIR}/${db}"/*.sql* 2>/dev/null | head -1)
    [ -z "$last" ] && { echo ""; return; }
    local age_s=$(( $(date +%s) - $(stat -c %Y "$last") ))
    echo $(( age_s / 3600 ))
}

# Compte de dumps R2 pour une DB (= rétention réelle)
saas_backup_r2_count() {
    local db="$1"
    "$RCLONE_BIN" ls "r2:veridian-backups/${db}/" 2>/dev/null | wc -l
}

# Map un nom de container prod (long) vers le repo SaaS qu'il appartient (court)
container_to_repo() {
    local cname="$1"
    case "$cname" in
        *nl2k9p-hub*)        echo "veridian-hub" ;;
        *l5fmki-prospection*) echo "veridian-prospection" ;;
        *i9bv43-analytics*)   echo "veridian-analytics" ;;
        *e9xlnn-cms*)         echo "veridian-cms" ;;
        *k9lvap-notifuse*)    echo "notifuse-veridian" ;;
        *)                    echo "" ;;
    esac
}

# Localise le fichier compose à éditer pour un repo donné
repo_compose_file() {
    case "$1" in
        veridian-hub)          echo "compose/base.yml" ;;
        veridian-prospection)  echo "infra/docker-compose.base.yml" ;;
        veridian-analytics)    echo "docker-compose.yml" ;;
        veridian-cms)          echo "docker-compose.yml" ;;
        notifuse-veridian)     echo "infra/compose/prod.yml" ;;
        *)                     echo "?" ;;
    esac
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

    echo ""
    echo "## Routes Traefik PROD (extraites depuis labels Docker live)"
    remote_traefik_routes 100.88.202.29 | format_traefik_routes
    echo ""
    echo "## Routes Traefik DEV (staging — privatisé via Tailscale)"
    remote_traefik_routes --alias dev-pub | format_traefik_routes

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
    fi

    # ─── Container resources (fusible 60% VM) ────────────────────────────
    echo ""
    echo "## Container resources prod (politique fusible 60% VM)"
    local res; res=$(saas_container_resources)
    if [ -z "$res" ]; then
        echo "  ⚠ Impossible de récupérer les stats containers prod."
        echo "    Que fait la commande qui a échoué :"
        echo "      ssh ubuntu@100.88.202.29 'docker stats --no-stream + docker inspect'"
        echo "      → liste tous containers prod avec leur usage RAM/CPU et leur"
        echo "        mem_limit configuré (HostConfig.Memory)."
        echo "    Causes possibles :"
        echo "      1. SSH vers prod inaccessible (clé ~/.ssh/id_rsa_ovh manquante,"
        echo "         Tailscale down, prod-pub absent de ~/.ssh/config)"
        echo "      2. ubuntu n'a pas les droits docker (group docker manquant)"
        echo "      3. Docker daemon arrêté sur prod"
        echo "    Pour tester en manuel : ssh prod-pub 'docker stats --no-stream | head -5'"
        echo "    Si la commande répond → bug dans saas_container_resources (signale)"
        echo "    Si elle échoue → fix l'accès SSH/docker d'abord, le hook réessaiera"
        return
    fi
    # Compte par status
    local nb_ok=0 nb_warn=0 nb_low=0 nb_nofuse=0
    local lines_nofuse=() lines_low=() lines_warn=()
    while IFS='|' read -r name used lim cpu status; do
        [ -z "$name" ] && continue
        case "$status" in
            OK)         nb_ok=$((nb_ok+1)) ;;
            WARN_HIGH)  nb_warn=$((nb_warn+1)); lines_warn+=("$name|$used|$lim|$cpu") ;;
            TOO_LOW)    nb_low=$((nb_low+1)); lines_low+=("$name|$used|$lim|$cpu") ;;
            NO_FUSE)    nb_nofuse=$((nb_nofuse+1)); lines_nofuse+=("$name|$used|$cpu") ;;
        esac
    done <<< "$res"
    local total=$((nb_ok + nb_warn + nb_low + nb_nofuse))
    printf "  Bilan: %d containers — ✓%d OK · ⚠%d HIGH-usage · 🔧%d limit-too-low · 🚨%d NO-FUSE\n" \
        "$total" "$nb_ok" "$nb_warn" "$nb_low" "$nb_nofuse"

    # Containers > 80 % de leur propre limite
    if [ "$nb_warn" -gt 0 ]; then
        echo ""
        echo "  ⚠ Containers proches de leur limite (>80%):"
        for l in "${lines_warn[@]}"; do
            IFS='|' read -r n used lim cpu <<< "$l"
            pct=$(( used * 100 / lim ))
            printf "    %-65s %5d/%d MB (%d%%) · cpu:%s%%\n" "${n:0:65}" "$used" "$lim" "$pct" "$cpu"
        done
    fi

    # Containers avec fusible sous-dimensionné (< 60 % VM)
    if [ "$nb_low" -gt 0 ]; then
        echo ""
        echo "  🔧 Containers avec limite < 60% VM (à remonter à 6600m):"
        for l in "${lines_low[@]}"; do
            IFS='|' read -r n used lim cpu <<< "$l"
            printf "    %-65s lim=%d MB (devrait être ≥6600 MB)\n" "${n:0:65}" "$lim"
        done
    fi

    # Containers SANS fusible — le pire cas
    if [ "$nb_nofuse" -gt 0 ]; then
        echo ""
        echo "  🚨 Containers SANS fusible (mem_limit=0, risque cascade OOM-VM):"
        local repos_to_fix=()
        for l in "${lines_nofuse[@]}"; do
            IFS='|' read -r n used cpu <<< "$l"
            local repo; repo=$(container_to_repo "$n")
            if [ -n "$repo" ]; then
                printf "    %-65s used=%d MB cpu:%s%% → repo:%s\n" "${n:0:65}" "$used" "$cpu" "$repo"
                # Tracker repos uniques à fix
                if [[ ! " ${repos_to_fix[*]} " == *" $repo "* ]]; then
                    repos_to_fix+=("$repo")
                fi
            else
                printf "    %-65s used=%d MB cpu:%s%% → infra (Dokploy/Traefik/CrowdSec)\n" "${n:0:65}" "$used" "$cpu"
            fi
        done

        # Action pour l'agent : commande explicite à exécuter pour chaque repo
        echo ""
        echo "  → Pour chaque repo concerné, l'agent doit câbler mem_limit/cpus"
        echo "    dans son docker-compose, puis push pour redéployer :"
        echo ""
        for repo in "${repos_to_fix[@]}"; do
            local cf; cf=$(repo_compose_file "$repo")
            local d="$SAAS_ROOT/$repo"
            echo "    [${repo}]"
            echo "      Fichier: ${d}/${cf}"
            echo "      Ajouter sous le service principal:"
            echo "        mem_limit: 6600m   # 60% des 11 GB VM"
            echo "        cpus: 3.6          # 60% des 6 CPU"
            echo "      Workflow: edit → git add → git commit → git push (CI deploy auto)"
            # Si Hub a déjà déposé un commit cross-repo, le signaler
            if [ -d "$d/.git" ]; then
                local cross_commit
                cross_commit=$(git -C "$d" log --grep='fusible 60' --grep='via Claude.*Hub' --all-match --since='3 days ago' --format='%h %s' 2>/dev/null | head -1)
                if [ -z "$cross_commit" ]; then
                    cross_commit=$(git -C "$d" log --grep='fusible 60' --since='3 days ago' --format='%h %s' 2>/dev/null | head -1)
                fi
                if [ -n "$cross_commit" ]; then
                    echo "      ✓ Commit déjà préparé localement par Hub-agent: ${cross_commit}"
                    echo "        → l'agent ${repo} n'a qu'à git push (après revue)"
                fi
            fi
            echo ""
        done
    fi

    # ─── DB Backups (sauvegardes journalières R2 + sync local) ────────────
    echo ""
    echo "## DB Backups (cron prod → R2 04:00 UTC, sync local 07:00 Europe/Paris)"
    if [ ! -d "$BACKUP_LOCAL_DIR" ]; then
        echo "  ⚠ Dossier ${BACKUP_LOCAL_DIR} introuvable — sync local jamais exécuté"
        echo "    Pour tester : rclone sync r2:veridian-backups/ ${BACKUP_LOCAL_DIR}/"
    else
        local bk_alerts=()
        local bk_total_ok=0
        for db in "${SAAS_BACKUP_DBS[@]}"; do
            local age_h r2_count age_str status
            age_h=$(saas_backup_local_age_h "$db")
            r2_count=$(saas_backup_r2_count "$db")
            if [ -z "$age_h" ]; then
                age_str="N/A"
                status="🚨 AUCUN DUMP"
                bk_alerts+=("$db: aucun dump local + ${r2_count} dumps R2")
            elif [ "$age_h" -lt 25 ]; then
                age_str="${age_h}h"
                status="✓"
                bk_total_ok=$((bk_total_ok+1))
            elif [ "$age_h" -lt 72 ]; then
                age_str="${age_h}h"
                status="⚠ retard"
                bk_alerts+=("$db: dernier dump ${age_h}h (cron prod peut-être down)")
            else
                local age_d=$(( age_h / 24 ))
                age_str="${age_d}j"
                status="🚨 CRON DOWN"
                bk_alerts+=("$db: dernier dump ${age_d}j — cron probablement cassé")
            fi
            # Rétention faible = peu de dumps R2
            local retention_warn=""
            if [ "${r2_count:-0}" -lt 7 ] && [ "${r2_count:-0}" -gt 0 ]; then
                retention_warn=" ⚠rétention:${r2_count}"
            fi
            printf "  %s %-15s last:%-5s · R2:%2d dumps%s\n" "$status" "$db" "$age_str" "${r2_count:-0}" "$retention_warn"
        done

        # R2 storage usage vs free tier (10 GB)
        local r2_size_bytes r2_size_mb r2_pct
        r2_size_bytes=$("$RCLONE_BIN" size r2:veridian-backups 2>/dev/null | grep -oP 'Total size: [^(]+\(\K[0-9]+' | head -1)
        if [ -n "$r2_size_bytes" ]; then
            r2_size_mb=$(( r2_size_bytes / 1024 / 1024 ))
            r2_pct=$(( r2_size_bytes * 100 / 10737418240 ))   # 10 GB en bytes
            local r2_status="✓"
            [ "$r2_pct" -gt 70 ] && r2_status="⚠"
            [ "$r2_pct" -gt 90 ] && r2_status="🚨"
            echo ""
            printf "  R2 free tier: %s %d MB / 10240 MB (%d%%) — Class A/B ops illimité côté monitoring\n" \
                "$r2_status" "$r2_size_mb" "$r2_pct"
        fi

        # Si des alertes, expliquer la commande de fix
        if [ ${#bk_alerts[@]} -gt 0 ]; then
            echo ""
            echo "  🔧 Actions si backup cassé :"
            echo "    1. Vérifier que le cron tourne sur prod :"
            echo "       ssh prod-pub 'sudo cat /etc/cron.d/veridian-backups'"
            echo "    2. Vérifier les logs cron :"
            echo "       ssh prod-pub 'tail -20 /var/log/veridian-backups.log'"
            echo "    3. Test manuel pour identifier l'erreur précise :"
            echo "       ssh prod-pub 'set -a; . /home/ubuntu/.backup-env; set +a;"
            echo "         bash -x /home/ubuntu/backup-postgres.sh <db> <container> <user> <dbname>'"
            echo "    4. Causes connues :"
            echo "       • Container renommé → fix /etc/cron.d/veridian-backups (sudo sed)"
            echo "       • Cron manquant pour une nouvelle DB → ajouter ligne au fichier"
            echo "       • Log /var/log/veridian-backups.log non writable → chown ubuntu:ubuntu"
        fi
    fi
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
# Main render — 3 sections in order
###############################################################################

render_section_global
echo ""
echo ""
render_section_saas_overview
echo ""
echo ""
render_section_current_repo

# --- Crypto : constantes établies + verdict gas du jour — non bloquant ---
echo ""
echo ""
echo "# CRYPTO — constantes à garder en tête (détail : crypto facts)"
if [ -x "$HOME/.local/bin/crypto" ]; then
    "$HOME/.local/bin/crypto" facts --line 2>/dev/null
    timeout 8 "$HOME/.local/bin/crypto" gas --line 2>/dev/null || echo "  ⛽ gas indisponible (réseau) — lancer 'crypto gas' plus tard"
else
    echo "  (CLI crypto absent)"
fi

exit 0
