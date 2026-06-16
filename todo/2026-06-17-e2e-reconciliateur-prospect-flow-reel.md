# [HUB] 🔴 P1 — Spec E2E manquante : réconciliateur prospect promu en prod SANS test de bout en bout

> **Sévérité** : 🔴 P1 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Contexte

Le réconciliateur prospect (Lot 1) a été **promu en prod le 2026-06-17** (commits 5f74282 + 37c74ad,
run CI 27650883471) : tables `hub_app.prospect_events` + `hub_app.prospect_scores` (migration
`20260615120000` appliquée et vérifiée en prod), ingestion + scoring V1 (`lib/prospect/ingest.ts`,
`lib/prospect/scoring.ts`), 3 handlers webhook (voie legacy HMAC dans
`app/api/webhooks/notifuse/route.ts` + voie v1.4 Bearer dans `lib/webhooks/notifuse-handlers.ts`).

**Le trou (prouvé)** : il n'existe **aucune spec E2E** qui teste le flow réel de bout en bout
(webhook signé → ingestion → row en DB → score). Vérifié sur `origin/main` :

- `git grep -nl "prospect_events|prospect_scores|ProspectEvent|ProspectScore|engagementScore|email\.clicked|behavioral" -- 'e2e/**'` → **AUCUN match**.
- Aucun helper SQL E2E ne connaît les tables (`e2e/staging-full/_sql-helper.ts`, `mega/_fixtures/downstream-db.ts`) → impossible d'assert un état DB prospect aujourd'hui.

Ce qui EST testé (et qui est bon, à ne pas refaire) :
- Tests unitaires `lib/prospect/ingest.test.ts` + `scoring.test.ts` : couverture solide (dédup P2002,
  workspace orphelin tenantUuid null, page.hit sans email, eventType inconnu, upsert incrémental,
  out-of-order, normalisation email).
- Tests route/handler `__tests__/api/webhooks/notifuse.test.ts` + `__tests__/lib/webhooks/notifuse-handlers.test.ts` :
  vérifient la délégation des deux voies de transport vers `ingestProspectEvent` — **mais `ingestProspectEvent`
  est MOCKÉ**, donc rien ne prouve que le flow réel (HMAC réel → DB réelle) fonctionne.

C'est exactement le pattern de l'incident 2026-05-23 (CI verte avec des mocks, zéro flow réel) que la
règle team-lead "E2E lourd obligatoire avant promo main" est censée empêcher. Ici la promo prod a eu
lieu sans cet E2E.

## Demande précise

Créer **une spec E2E** `e2e/staging-full/mega/<dossier>/XX-reconciliateur-prospect-flow.spec.ts`
(ou `e2e/staging-full/21-reconciliateur-prospect.spec.ts` selon la convention retenue) qui teste le
flow réel contre staging :

1. **Voie LEGACY HMAC** (celle qui émet en prod aujourd'hui) :
   - POST `https://hub.staging.veridian.site/api/webhooks/notifuse` avec un body
     `{ event_id: <uuid v4>, event_type: "email.clicked", tenant_id: "<workspace slug staging>",
       occurred_at: <ISO>, data: { contact_email: "e2e-prospect@veridian.test", link_url: "https://x" } }`
   - Signature `X-Veridian-Notifuse-Signature = HMAC-SHA256(secret, "${ts}.${rawBody}")` +
     `X-Veridian-Timestamp` (ms). **Réutiliser le helper de signature HMAC déjà présent** dans
     `e2e/staging-full/mega/I-security/I-02-hmac-tampering.spec.ts` /
     `mega/H-invitations-oauth-bounce/H-01-invitation-cross-app.spec.ts`.
   - Assert HTTP 200/2xx.
   - **Assert DB** (ajouter les helpers SQL nécessaires dans `_sql-helper.ts`, sur le modèle de
     `selectScalar` / `selectRow`) :
     - `SELECT count(*) FROM hub_app.prospect_events WHERE idempotency_key = '<event_id>'` → **1**
     - `SELECT engagement_score, signals FROM hub_app.prospect_scores WHERE workspace_slug = '<slug>' AND contact_email = 'e2e-prospect@veridian.test'`
       → `engagement_score = 5`, `signals = {"clicked": 1}`.
2. **Idempotence (replay)** : re-POST le **même** `event_id` → 2xx, mais
   `count(prospect_events) reste 1` ET `engagement_score reste 5` (pas de double comptage).
3. **Cumul de score** : POST un second event (`email.replied`, nouvel `event_id`, même email) →
   `engagement_score = 25` (`5 + 20`), `signals = {"clicked":1,"replied":1}`.
4. **(optionnel mais recommandé) Voie v1.4 Bearer** : même assertion via
   `POST /api/webhooks/notifuse` en `Authorization: Bearer <token>` au format §7.5.1, pour prouver que
   les deux voies convergent sur le même état DB.
5. **Cleanup** : supprimer les rows `prospect_events` / `prospect_scores` du prospect E2E en teardown
   (ajouter au `_global-teardown.ts` / `_cleanup-helper.ts`), pour ne pas polluer staging.

## Impact

- **Aujourd'hui** : on shippe à l'aveugle. Une régression sur la signature HMAC, la résolution tenant,
  l'upsert de score ou la migration ne serait détectée par **aucun** test automatisé — uniquement par
  l'absence silencieuse de rows en prod (cf ticket observabilité associé).
- Sans cet E2E, la règle "E2E lourd avant promo main" est inapplicable au réconciliateur : il n'y a
  rien à lancer.
- **Prérequis levé** : staging Hub existe, le helper `runSqlOnStaging` existe, les helpers de signature
  HMAC existent. Le ticket est purement additif (≈ 1 spec + 2-3 helpers SQL), aucun changement de code prod.

## Priorité

🔴 P1 — c'est le trou le plus important de l'audit parité. Feature prod réellement non couverte E2E.
À câbler avant tout nouvel étage (vid / page.hit / push CRM), sinon la dette de non-couverture grossit
à chaque lot.
