# [HUB] 🟢 P2 — Endpoint admin de lecture des scores prospect (debug + alimentation)

> **Sévérité** : 🟢 P2 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)
> **Type** : feature — expose la SORTIE du réconciliateur en lecture

## Contexte (prouvé par audit 2026-06-17)

`hub_app.prospect_scores` est écrit par le réconciliateur (Lot 1 en prod) mais
**aucune route API ne l'expose en lecture**. Preuve :

- `grep -rn 'prospectScore\.(findMany|findFirst|...)' app/api/` → **VIDE**.
- Inventaire complet de `app/api/` : aucune route `prospect`/`scores` (il
  existe `app/api/webhooks/notifuse` qui INGÈRE, rien qui LIT).

Conséquence opérationnelle : aujourd'hui, pour vérifier qu'un event Notifuse a
bien bougé le score d'un prospect (debug, validation E2E, support), il faut se
connecter à la DB Postgres prod en SQL brut. Pas d'observabilité applicative sur
le résultat du scoring.

## Demande précise

Créer **`GET /api/admin/prospect-scores/route.ts`** :

- Auth `requireAdmin()` côté serveur (pas juste middleware Edge —
  CVE-2025-29927 ; suivre le pattern des autres routes `app/api/admin/*`).
- Headers no-cache (route admin).
- Querystring (clampés) :
  - `workspaceSlug` (optionnel, filtre) ;
  - `minScore` (optionnel, défaut 0) ;
  - `limit` (1..200, défaut 50) ;
  - tri par `engagementScore DESC` (utilise l'index existant
    `(workspace_slug, engagement_score DESC)`).
- Réponse : `{ items: [{ contactEmail, workspaceSlug, engagementScore,
  signals, lastEventAt, vid }], total }`.
- **Ne JAMAIS** renvoyer le payload brut des events (PII) — juste l'agrégat
  `prospect_scores`.

Optionnel (même PR si rapide) : un sous-endpoint
`GET /api/admin/prospect-scores/[email]/events` qui liste les
`prospect_events` d'un prospect (forensics : "pourquoi ce score ?"), borné +
admin-only.

## Impact business

Secondaire mais utile : débloque le **debug et la validation** du réconciliateur
(prouver que le scoring marche en prod sans SQL manuel), et sert de **brique
d'alimentation** pour le ticket dashboard (`2026-06-17-dashboard-carte-prospects-chauds.md`)
et pour une éventuelle consommation cross-app future.

## Dépendances

- Aucune. Lecture pure sur une table existante. Peut être livré avant ou après
  le push CRM.
- Si le ticket dashboard est fait, il consommera CETTE route → la faire en
  premier des deux est cohérent.

## Tier de risque (CI-ARCHITECTURE §20)

🟡 MOYEN (nouvelle route admin en lecture seule, pas de migration, pas de
surface non-auth). Promotion agent autonome après reco + smoke CI.
