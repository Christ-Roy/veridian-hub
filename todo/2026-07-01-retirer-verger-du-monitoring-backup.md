# [HUB] Retirer verger-shop du monitoring backup (DB migrée sur Neon)

> **Sévérité** : 🟢 P2 (nettoyage monitoring — action déjà appliquée localement)
> **Owner** : agent veridian-hub
> **Créé** : 2026-07-01 par agent prospection (demande Robert, fin de session)

## Contexte
`verger-shop` a migré sa DB sur **Neon** (serverless, freemium) le 2026-06-27 —
le cron de backup local est commenté sur prod (`# MIGRÉ EDGE CLOUD` dans
`/etc/cron.d/veridian-backups`, géré par veridian-infra). Neon gère ses propres
backups/PITR. Il n'y a donc plus de dump Docker local à surveiller.

Résultat : le hook SessionStart affichait `🚨 CRON DOWN verger-shop last:7j` —
un **faux positif** (l'alerte comptait les 30 vieux dumps R2 qui vieillissent).

## Fait (à committer proprement côté Hub)
J'ai retiré `verger-shop` de `SAAS_BACKUP_DBS` dans
`scripts/ops/claude-hooks/infra-status.sh` (édition locale, syntaxe validée
`bash -n`, signal coupé au prochain SessionStart). **À committer/promouvoir**
avec ton WIP en cours pour que le retrait soit versionné (sinon un pull réécrase).

## Reste (optionnel, à arbitrer)
- Les 30 dumps R2 historiques `r2:veridian-backups/verger-shop/` sont conservés
  (archive). Les purger si on veut libérer le quota R2 (actuellement 47%).
- Décider si on veut surveiller les backups Neon (le free tier n'exporte pas de
  dump ; PITR ~7j). Sinon, verger n'a plus de backup exportable côté Veridian.
