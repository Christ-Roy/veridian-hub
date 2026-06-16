# [HUB] 🟡 P1 — Corriger `CONTRAT-HUB.md §7.5` : il affirme à tort que Notifuse émet déjà les events comportementaux

> **Sévérité** : 🟡 P1 (incohérence doc qui masque l'état orphelin du réconciliateur)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (audit cohérence réconciliateur, agent audit-crossapp)

## TL;DR
Le contrat `docs/CONTRAT-HUB.md §7.5` (gravé 2026-06-15) décrit le réconciliateur
comme **alimenté en prod** par Notifuse. C'est FAUX : Notifuse n'émet aucun
`email.opened/clicked/replied` (prouvé). Cette doc fausse a fait croire que « le
backend est branché » alors qu'il est **orphelin** (0 row prod). À corriger pour
ne pas re-tromper le prochain agent.

## Citations fausses à corriger
1. §7.5.2 voie 2 (Legacy HMAC) :
   > « C'est par là que le **fork Notifuse émet aujourd'hui** ses
   > `email.opened/clicked/replied` (cf `internal/service/veridian_webhook_emitter.go`). »
   → **FAUX.** L'emitter Notifuse n'a aucune constante `email.opened/clicked/replied`
   (liste exhaustive `VeridianEvent` dans `internal/domain/veridian.go:1009+` :
   `email.{sent,bounced,complaint}` uniquement). Les 21 call-sites `.Emit(` réels
   ne couvrent que `tenant.*` + `email.{sent,bounced,complaint}` + quota/threshold.
   La donnée open/click EXISTE en interne (`OpenEmail`→`SetOpened`,
   `VisitLink`→`SetClicked`) mais n'est JAMAIS propagée au Hub.

2. Idem dans les en-têtes de code qui répètent l'affirmation :
   - `lib/prospect/ingest.ts` (commentaire « c'est par là que le fork Notifuse
     émet AUJOURD'HUI »).
   - `app/api/webhooks/notifuse/route.ts` (commentaire « Voie LEGACY HMAC = celle
     qu'emprunte le fork Notifuse aujourd'hui »).
   - `lib/webhooks/notifuse-handlers.ts` (« Le fork Notifuse émet aujourd'hui via
     la voie LEGACY HMAC »).
   → Tous à reformuler en **futur conditionnel** : « émettra une fois le ticket
   Notifuse `2026-06-17-emettre-events-comportementaux-...` livré ».

## Demande précise
- Reformuler §7.5.2 et §7.5 (intro) : les 3 handlers `email.*` côté Hub sont
  **PRÊTS À RECEVOIR mais aucun émetteur ne les alimente encore**. Statut réel :
  « récepteur livré (Lot 1), émetteurs (Notifuse `email.*`, Analytics `page.hit`)
  PAS encore câblés → réconciliateur orphelin tant que les tickets émetteurs
  ne sont pas livrés ».
- Corriger les 3 commentaires de code (lecture seule pour cet audit — l'agent Hub
  édite). Garder le code tel quel (il est correct, c'est juste la doc qui ment).
- Ajouter un encart « État d'alimentation 2026-06-17 » pointant les 3 tickets
  émetteurs (2 Notifuse + 1 Analytics + 1 route Hub analytics).

## Impact business
Une doc qui dit « ça marche » alors que 0 signal n'arrive = on croit avoir une
feature de scoring prospect qu'on n'a pas. Risque : Robert priorise mal (« le
scoring est livré, branchons le CRM ») alors que la base — recevoir un seul
event réel — n'est pas là. Corriger la doc = rendre l'état réel lisible.

## Dépendances
- Aucune (pure doc/commentaires). Livrable seul, tier 🟢 BAS `[risk:low]`.
- À garder cohérent avec les tickets émetteurs (Notifuse events + Analytics page.hit).
