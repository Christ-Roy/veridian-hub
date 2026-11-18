# [HUB] 🔴 P0 — Câbler `ENGINE_ADMIN_*` dans le compose Hub prod : le réconciliateur Analytics tourne À VIDE

> **Sévérité** : 🔴 P0 (le réconciliateur prospect ne reçoit AUCUN signal web en prod, silencieusement)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (audit cohérence identité/réconciliateur, agent audit-identite)

## TL;DR

Le pull Analytics → `prospect_events` est **entièrement codé, testé, et le cron
tourne toutes les heures en prod** (`hub-pull-analytics-cron.yml`, `37 * * * *`).
**MAIS les credentials engine (`ENGINE_ADMIN_EMAIL` / `ENGINE_ADMIN_PASSWORD` /
`ENGINE_BASE_URL` / `ENGINE_WORKSPACE_ID`) sont ABSENTS du compose Hub prod
Dokploy.** Conséquence : `EngineClient.isConfigured()` renvoie `false`, le cron
répond `skipped: true` (200, 0 event, **aucune alerte Telegram**) à CHAQUE tick.

**Le réconciliateur tourne à vide depuis sa mise en prod. Zéro `page.hit`
analytics n'est jamais ingéré.** Le volet web du scoring prospect est mort, en
silence (le cron est "vert").

## Preuve (vérifiée par le code + la prod, 2026-06-17)

### Le flux PULL est complet et câblé
- `app/api/cron/pull-analytics/route.ts:64` → `pullAnalytics(pullDepsFromEnv())`.
- `lib/prospect/analytics-pull.ts:226` → `if (!deps.engine.isConfigured()) return { ...empty, skipped: true }`.
- `lib/prospect/engine-client.ts:75-79` → `isConfigured()` = `adminEmail.length > 0 && adminPassword.length > 0`.
- `lib/prospect/engine-client.ts:54-64` → `engineConfigFromEnv` lit `ENGINE_ADMIN_EMAIL` / `ENGINE_ADMIN_PASSWORD` (défaut `''`), `ENGINE_BASE_URL` (défaut `https://analytics-engine.app.veridian.site`), `ENGINE_WORKSPACE_ID` (défaut `vrd_veridian_site_prod`).
- `.github/workflows/hub-pull-analytics-cron.yml` : cron horaire `37 * * * *`, POST `https://app.veridian.site/api/cron/pull-analytics`. Le commentaire du workflow le dit lui-même : *"Credentials engine (ENGINE_ADMIN_*) : côté compose prod du Hub, pas en CI. Si absents → skipped: true (200) — pas d'échec."*
- Test `__tests__/api/cron/pull-analytics.test.ts:102-115` : le cas `skipped: true` → 200, `sendTelegramAlert` **non appelé**. Donc l'absence de creds est totalement silencieuse en prod.

### La prod ne porte PAS les ENV
Compose Hub prod Dokploy (`composeId=_kxAHDCv1LhvsdwNRX3Vk`), inspecté via
`GET /api/compose.one` le 2026-06-17 :
```
ENV keys liés engine/cron : ['CRON_SECRET']
ENGINE_ADMIN_EMAIL    présent : False
ENGINE_ADMIN_PASSWORD présent : False
ENGINE_BASE_URL       présent : False
ENGINE_WORKSPACE_ID   présent : False
```
Seul `CRON_SECRET` est là → le cron s'authentifie et part, mais skip
immédiatement faute de creds engine.

## Demande précise (quoi câbler, où)

1. **Provisionner un compte admin engine pour le Hub** (login programmatique,
   token 7 j, re-login auto sur 401 — cf `engine-client.ts:81-101`). L'engine
   ne permet PAS d'API key sur un workspace platform-managed (403 vérifié côté
   bridge 2026-06-10) → c'est bien un login email/password super-admin qu'il
   faut. Choisir/réutiliser un compte admin de l'engine prod
   (`analytics-engine.app.veridian.site`, workspace `vrd_veridian_site_prod`).
2. **Câbler les 4 ENV dans le compose Hub prod Dokploy** (`POST /api/compose.update`
   body `{composeId: "_kxAHDCv1LhvsdwNRX3Vk", env}` puis `POST /api/compose.deploy`) :
   - `ENGINE_BASE_URL=https://analytics-engine.app.veridian.site`
   - `ENGINE_WORKSPACE_ID=vrd_veridian_site_prod`
   - `ENGINE_ADMIN_EMAIL=<compte admin engine>`
   - `ENGINE_ADMIN_PASSWORD=<password>` (secret — depuis `~/credentials/.all-creds.env`
     ou rotation dédiée ; jamais en clair dans le repo). Cf memory
     `feedback_env_wire_compose_same_commit` (ENV lue par le code = câblée dans
     le déploiement, sinon code aveugle).
3. **Vérifier après deploy** : déclencher le cron manuellement
   (`workflow_dispatch` ou `curl -X POST .../api/cron/pull-analytics -H "Authorization: Bearer $CRON_SECRET"`)
   et confirmer dans la réponse `skipped: false` + `pulled > 0` (si du trafic
   identifié existe sur l'engine), puis `SELECT count(*) FROM hub_app.prospect_events`
   non nul.

## Trou secondaire à vérifier en même temps : mapping tenant analytics
`ingestProspectEvent` résout le tenant Hub via `resolveTenantByExternalId('analytics', 'vrd_veridian_site_prod')`
(`lib/prospect/ingest.ts:109`, `lib/sync/snapshot-updater.ts`). Pour matcher, un
tenant Hub doit porter `metadata.analytics.workspace_id = 'vrd_veridian_site_prod'`
(posé par `lib/admin/link-app.ts`). Si aucun tenant ne le porte, les `page.hit`
sont quand même ingérés (best-effort, `tenant_uuid` NULL = forensics) mais NON
rattachés à un tenant. **À vérifier** : un tenant Hub a-t-il bien linké
l'analytics avec ce workspace_id ? Sinon, `link-app` analytics à exécuter.

## ⚠️ Incohérence DOC à corriger dans la foulée (même repo)

`docs/CONTRAT-HUB.md §7.5` (encadré "État au 2026-06-17", l.2568-2585 + l.2607,
2622-2627, 2647-2652) décrit l'émetteur Analytics comme un **PUSH webhook
`page.hit` v1.4 Bearer "❌ PAS câblé"** et renvoie à
`veridian-hub/todo/2026-06-17-creer-route-webhook-analytics-page-hit.md` +
au ticket legacy analytics. **C'est PÉRIMÉ.** Le design retenu (code daté
2026-06-17, plus récent que la doc) est un **PULL** : le Hub pull lui-même
`export.userEvents` de l'engine et fabrique les `page.hit` côté Hub
(`lib/prospect/analytics-pull.ts`). Il n'y a **pas** de route réceptrice
`/api/webhooks/analytics` à créer, et l'engine n'a **rien à pousser**.

→ **Action doc** : dans `§7.5`, remplacer la ligne "Émetteur Analytics (page.hit)
PAS câblé / route réceptrice à créer" par "Analytics : alimenté par PULL
(`cron/pull-analytics` → `export.userEvents`), code livré ; bloqué uniquement
sur les ENV `ENGINE_ADMIN_*` prod (ce ticket)". Et fermer/annuler le ticket
miroir `2026-06-17-creer-route-webhook-analytics-page-hit.md` (route PUSH
inutile dans le design PULL). Voir le ticket engine
`todo/2026-06-17-corriger-ticket-legacy-page-hit-push-vs-pull.md` (déposé par
audit-identite) qui documente la bascule PUSH→PULL côté analytics.

## Impact business
Sans ces ENV, le réconciliateur de prospects de Robert **ne voit jamais le web**
en prod : aucune visite `/audit`, `/tarifs`, `/contact` n'est corrélée à un
prospect, le barème `page.hit +3` ne s'applique sur RIEN. Toute la promesse
cold↔web (recoupement multi-canal pour prioriser les leads chauds) est morte
silencieusement alors que tout le code derrière est livré et testé. C'est le
maillon le moins coûteux à fermer (4 ENV) pour le plus gros débloquage.

## Dépendances
- L'autre émetteur du réconciliateur (Notifuse `email.opened/clicked/replied`)
  est lui aussi "❌ PAS câblé" (cf §7.5, ticket
  `notifuse-veridian/todo/2026-06-17-emettre-events-comportementaux-...`). Les
  deux sont indépendants : câbler les ENV engine débloque DÉJÀ le volet web seul.
- Le `vid` déterministe partagé (étage 2, jointure forte cold↔web) reste non
  câblé — au V1 la jointure web↔prospect se fait par `contact_email` (donc un
  `page.hit` est attribué seulement si le visiteur s'est identifié par email via
  `identify(email)` côté site — cf `docs/TUNNEL-IDENTITE.md` côté engine). C'est
  un autre lot, pas bloquant pour démarrer l'ingestion.
