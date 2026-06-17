# Ingérer email.bounced / email.unsubscribed pour la disqualification prospect

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17
> **Révélé par** : juge de paix tunnel (E2E `e2e/tunnel/`, gate G8c)

## Contexte

En câblant le juge de paix de parité bridge→Hub (`e2e/tunnel/gates.spec.ts`),
3 constats sur le scope d'ingestion réel du réconciliateur :

| Event type | Barème (`scoring.ts`) | Ingéré au V1 ? | Voie |
|---|---|---|---|
| `email.opened` | OPEN_FIRST +5 | ✅ | legacy HMAC + v1.4 Bearer |
| `email.clicked` | CLICK_FIRST/EXTRA | ✅ | legacy HMAC + v1.4 Bearer |
| `email.replied` | EMAIL_REPLIED +35 | ✅ | legacy HMAC + v1.4 Bearer |
| `email.sent` | baseline (0 pt) | ✅ **câblé c09d894** | legacy HMAC + v1.4 Bearer |
| `email.bounced` | **disqualified** | ❌ **non ingéré** | — |
| `email.unsubscribed` | **disqualified** | ❌ **non ingéré** | — |
| `page.hit` | famille Analytics | ❌ (cron pull seul) | route /analytics à créer |

> **MàJ 2026-06-17** : `email.sent` a été câblé (commit `c09d894`, suite au
> CONSTAT 1 du juge de paix) → le stage NEW→SCREENING peut maintenant se
> déclencher via le flux réel. Reste ce ticket : **`email.bounced` /
> `email.unsubscribed`** (disqualification), le seul point à impact prod.

Le scope V1 reste conforme au contrat §7.5.1. Les event types non ingérés ne
sont **pas des bugs** — `aggregateSignals` les gère déjà (forward-compat), mais
aucun émetteur/handler ne les câble.

## Le point qui mérite un fix (P1)

`email.bounced` et `email.unsubscribed` pilotent la **disqualification**
(`disqualified=true` → `doNotContact` côté CRM, `scoring.ts:179`). Tant qu'ils ne
sont pas ingérés :

- **un prospect qui bounce dur reste contactable** (pas de `doNotContact` via le
  flux réel) → risque délivrabilité / réputation sur du cold outreach.
- un prospect qui se désinscrit n'est pas marqué opt-out côté scoring.

Le bridge historique, lui, recevait et traitait ces events.

## Demande

Ajouter `email.bounced` / `email.unsubscribed` (+ `email.complained`) à
l'ingestion, par les DEUX voies (cohérence avec opened/clicked/replied) :

1. **Legacy HMAC** (`app/api/webhooks/notifuse/route.ts`) : ajouter les cases
   `email.bounced` / `email.unsubscribed` / `email.complained` au bloc qui
   délègue à `ingestProspectEvent` (à côté de opened/clicked/replied, ligne ~316).
2. **v1.4 Bearer** (`lib/webhooks/notifuse-handlers.ts`) : ajouter les handlers
   correspondants dans `v14Handlers` (même pattern que `email.opened`).

Aucune migration DB (la table accepte n'importe quel `event_type`). Le barème
est déjà prêt. Une fois câblé, inverser l'assertion du gate G8c du juge de paix
(`e2e/tunnel/gates.spec.ts`) : `email.bounced` → `disqualified=true`, `score=0`.

## Hors scope (séparé)

- `page.hit` via webhook : ticket dédié `2026-06-17-creer-route-webhook-analytics-page-hit.md`
  (cf contrat §7.5 ligne 2579). Au V1 page.hit entre par le cron pull-analytics.
- ✅ `email.sent` ingéré : **fait** (commit `c09d894`) — stage NEW→SCREENING
  déclenchable via le flux réel.
