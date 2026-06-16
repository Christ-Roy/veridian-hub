# [HUB] 🟡 P2 — Observabilité nulle du réconciliateur prospect : 0 event ingéré en prod, personne ne le sait

> **Sévérité** : 🟡 P2 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Contexte

Le réconciliateur prospect est en prod depuis le 2026-06-17. Sa seule trace est du `console.info` :

- `app/api/webhooks/notifuse/route.ts:335` → `console.info('[notifuse-webhook] behavioral', eventType, slug, email, '+N'|'dedup')`
- `lib/prospect/ingest.ts` → `console.info('[prospect:ingest] dedup hit ...')` + `console.warn('[prospect:ingest] tenant resolution failed ...')`

**Aucune métrique, aucun dashboard, aucune alerte.** Vérifié sur `origin/main` :
- `git grep -nl "prospect_events|prospect_scores|engagementScore" -- 'app/api/cron/**' '.github/workflows/**'` → **AUCUN** cron/workflow ne surveille les tables.
- Le seul `hub-reconcile-cron.yml` concerne le **réconciliateur TENANT** (sync billing niveau 3, `lib/sync/reconcile.ts`), RIEN à voir avec le réconciliateur prospect.

## État prod réel (mesuré le 2026-06-17 via SSH prod-pub → core-db)

```
migration 20260615120000_add_prospect_events_and_scores : appliquée (finished_at non null)  ✅
hub_app.prospect_events  : count = 0
hub_app.prospect_scores  : count = 0
max(received_at)         : none  (jamais un seul event reçu)
```

C'est **attendu au Lot 1** : Notifuse n'émet pas encore les events comportementaux en prod, Analytics
`page.hit` n'est pas branché. Mais le problème de fond reste : **le jour où un émetteur commencera à
pousser, rien ne dira si ça marche ou pas**. Un bug de signature HMAC, de mapping tenant, ou une route
qui renvoie 500 en silence laisserait la table à 0 indéfiniment, et personne ne le verrait. À l'inverse,
un flot d'events qui n'arrivent jamais à scorer (tous `contact_email` null → `scored:false`) passerait
aussi inaperçu.

## Demande précise

Câbler une observabilité minimale (pas de cathédrale — cf règle d'or "clean & smart, lisible en 5 min") :

1. **Métriques de base** — option légère et cohérente avec la stack existante :
   - Soit exposer un compteur via la table `hub_app.app_metrics` (déjà au schéma Prisma, `metricType` /
     `timestamp`) incrémenté à chaque ingestion réussie (`events_ingested`, `events_deduped`,
     `events_scored`, `tenant_resolution_failed`).
   - Soit un endpoint admin `GET /api/admin/prospect/stats` (requireAdmin) qui renvoie, par tenant :
     `events_total`, `events_24h`, `scores_total`, `top_engagement`, `last_received_at`. Lecture directe
     des deux tables (les index `[workspaceSlug, engagementScore desc]` et `[workspaceSlug, eventType]`
     existent déjà, requêtes peu coûteuses).
2. **Alerte "silence anormal"** — un cron léger (style `hub-trial-drift-cron.yml`, notif Telegram sur
   anomalie) qui, **une fois qu'un émetteur est censé tourner**, alerte si :
   - `max(received_at)` > N heures (les events ont cessé d'arriver), OU
   - taux d'events `scored:false` (contact_email null / eventType inconnu) anormalement haut.
   > Tant qu'aucun émetteur n'est branché en prod (état actuel), garder l'alerte **désactivée /
   > seuil = 0** pour éviter le bruit — l'activer dans le même lot que le branchement du premier
   > émetteur comportemental (Notifuse vid ou Analytics page.hit).
3. **(facultatif) Dashboard** : si la stack obs Veridian (Grafana / autre) expose la DB Hub, ajouter
   un panneau "events comportementaux/jour par tenant + top prospects". À cadrer avec l'agent infra —
   ne PAS sur-investir tant que le volume est nul.

## Impact

- **Sans ça** : la feature peut être "morte en silence" en prod sans aucun signal — exactement le risque
  que la règle d'or Veridian (zéro contournement, observabilité par défaut) cherche à éviter. On a déjà
  0 row et c'est invisible.
- **Avec ça** : on sait à tout instant si l'ingestion vit, on attrape un branchement raté côté émetteur
  dès le premier event qui n'arrive pas.
- Coût faible (1 endpoint admin OU compteur app_metrics + 1 cron sur le modèle existant). Aucune migration
  destructive.

## Priorité

🟡 P2 — pas bloquant tant qu'aucun émetteur ne tourne en prod, MAIS à livrer **en même temps que le
premier branchement émetteur** (Notifuse vid / Analytics page.hit). Brancher un émetteur sans cette
observabilité = repartir aveugle.
