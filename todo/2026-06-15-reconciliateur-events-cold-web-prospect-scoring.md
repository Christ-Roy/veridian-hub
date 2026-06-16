# [HUB] 🟡 Réconciliateur events cold↔web + identité prospect partagée (porté par le Hub)

> **Type** : feature cross-app (Hub porteur). Déposé par agent Notifuse 2026-06-15.
> **Décision Robert** : le réconciliateur vit DANS LE HUB (pas un micro-service —
> veridian-tunnel-de-vente était une ébauche locale). Le Hub a la BDD + fait la jointure + scoring.

## Besoin
Corréler events cold (Notifuse : clic/ouverture/réponse) + visites web (Analytics : page.hit)
par un ID prospect DÉTERMINISTE (vid) → score d'engagement → CRM Twenty. Spec complète côté
Notifuse : `notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md`.

## Ce qui est attendu du HUB
1. **Identité prospect partagée** : étendre le modèle identité cross-app (`hub_user_id`) aux
   PROSPECTS (pas que les users Veridian). Le Hub est la source du `vid` propagé aux apps.
2. **Backend de réconciliation** (BDD Hub, distinct de `lib/sync/reconcile.ts` qui fait le billing) :
   consomme les events comportementaux émis par Notifuse + Analytics (taggés vid), joint, score, CRM.
3. **Prérequis = synchro tenant cross-app fiable** : le Hub doit mapper de façon sûre
   workspace Notifuse ↔ tenant Analytics ↔ client. Infra 3 niveaux codée (discovery/webhook/cron)
   mais Analytics pas branché proprement (cf décommission bridge legacy). Notifuse, lui, livre
   déjà discovery + events tenant.

## État émetteurs (vérifié 2026-06-15)
- Notifuse : discovery `users/by-email` ✅ + events tenant ✅ (VeridianWebhookEmitter). Manque : vid + events comportementaux.
- Analytics : à brancher (legacy/bridge à décommissionner d'abord).

## Pas urgent
Feature de scoring post-volume. Le tunnel cold Notifuse tourne sans. Spec pour cadrer l'archi.

## Statut — 2026-06-17 (Lot 1 EN PROD)
✅ **Lot 1 livré en prod** (commits 5f74282 + 37c74ad, promus prod le 2026-06-17,
   run CI 27650883471) :
- Tables `prospect_events` + `prospect_scores` créées en prod (schema hub_app),
  migration `20260615120000_add_prospect_events_and_scores` appliquée au boot
  (migrate-on-boot prouvé en prod réelle).
- Ingestion + scoring V1 par `contactEmail` (`lib/prospect/ingest.ts` + `scoring.ts`).
- Handlers webhook Notifuse (voie legacy HMAC + v1.4 Bearer) pour email.opened/clicked/replied.
- Standard event comportemental gravé `docs/CONTRAT-HUB.md §7.5`.

⏳ **Reste à faire (étages 2+)** — ticket maintenu pending :
- `vid` déterministe propagé cross-app (Notifuse doit l'émettre dans les liens /t/ /r/).
- Analytics `page.hit` branché (legacy/bridge à décommissionner d'abord).
- Synchro tenant 3 niveaux fiable (mapping workspace Notifuse ↔ tenant Analytics).
- Push vers CRM Twenty des prospects chauds (scoring → priorisation).
