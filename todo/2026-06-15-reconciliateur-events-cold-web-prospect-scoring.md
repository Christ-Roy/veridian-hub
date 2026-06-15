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
