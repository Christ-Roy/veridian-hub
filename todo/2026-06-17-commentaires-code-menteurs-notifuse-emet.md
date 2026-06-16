# [HUB] 🔵 P3 — Commentaires de code menteurs « Notifuse émet aujourd'hui »

> **Sévérité** : 🔵 P3 (cosmétique, comment-only — bloqué par check-test-mapping)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (suite audit cohérence réconciliateur)

## Contexte
Le contrat `docs/CONTRAT-HUB.md §7.5` a été corrigé (commit f460e90) : il ne ment
plus sur l'état d'émission (Notifuse n'émet PAS encore les events comportementaux,
ils sont captifs dans la DB Go, jamais `.Emit()`). Mais 3 commentaires de **code**
répètent encore le mensonge « le fork Notifuse émet aujourd'hui » :

- `app/api/webhooks/notifuse/route.ts:310` → « Voie LEGACY HMAC = celle qu'emprunte le fork Notifuse aujourd'hui »
- `lib/webhooks/notifuse-handlers.ts:206` → « Le fork Notifuse émet aujourd'hui via la voie LEGACY HMAC »
- `app/api/webhooks/notifuse/route.ts:14-16` → « permettre à Notifuse d'émettre dès aujourd'hui sans bloquer le côté Hub » (à nuancer : vrai pour le stub v1.4 tenant.*, mais trompeur lu à côté du réconciliateur)

## Pourquoi ce n'est pas déjà fait
Tentative de correction comment-only le 2026-06-17 → **refusée par le hook
pre-push `check-test-mapping`** : tout changement de `route.ts`/`notifuse-handlers.ts`
exige un changement du test mappé. Un commit comment-only seul ne passe pas, et
ajouter un test bidon juste pour passer le hook = bâclage (interdit, cf Robert
« NE BACLE PAS LES TESTS »).

## À faire
Corriger les 3 commentaires (« émet aujourd'hui » → « émettra une fois le ticket
Notifuse `2026-06-17-emettre-events-comportementaux-...` livré ; aujourd'hui
open/click captifs DB Notifuse ») **en même temps qu'une vraie modif testée**
de ces fichiers (ex : quand un agent câblera la route analytics ou ajustera un
handler), pour que le mapping test soit légitimement touché. Ou ajouter un
support « comment-only » au `check-test-mapping` (détecter diff = commentaires
seuls → exempter). Pas urgent, purement cosmétique.

## Impact
Nul fonctionnellement. Juste de la dette de lisibilité : un dev qui lit ces
commentaires croira que l'émission est branchée alors qu'elle ne l'est pas.
