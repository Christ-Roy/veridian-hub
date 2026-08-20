#!/usr/bin/env bash
# infra-status — lanceur du bloc « INFRA STATUS » (hook SessionStart).
#
# La logique vit dans infra_status.py, à côté. Ce lanceur existe pour que le
# symlink ~/.claude/hooks/infra-status.sh et la configuration de Claude Code
# restent inchangés, et pour que le hook n'empêche jamais une session de
# démarrer : quoi qu'il arrive, on sort en 0.
#
# Réglages : INFRA_STATUS_BUDGET (secondes, défaut 30)
#            INFRA_STATUS_DRYRUN=1 (exécute réellement le pre-push du dépôt courant)
exec python3 "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/infra_status.py" "$@"
