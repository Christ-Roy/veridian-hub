# [HUB] Alerting Telegram sur pic d'échecs OAuth

> **Sévérité** : 🟢 P2
> **Owner** : agent Hub
> **Créé** : 2026-05-22
>
> Reliquat extrait de `done/2026-05-20-oauth-rate-limiting-monitoring.md`
> (phases 1-3 livrées). Découplé pour ne pas garder un ticket à 95 % fait
> ouvert juste pour une brique.

## Contexte

Les phases 1-3 du monitoring OAuth sont livrées :

- ✅ Phase 1 (2026-05-20) : rate-limit IP `/api/auth/signin*` + `/callback*`,
  logger structuré `[auth-error][critical]`.
- ✅ Phases 2-3 (2026-05-22) : table `hub_app.oauth_signin_events`,
  logger `lib/auth/oauth-event-log.ts` (succès + échec), endpoint admin
  `GET /api/admin/oauth-events`.

Il reste **l'alerting** : être prévenu d'un pic d'échecs sans avoir à
consulter l'endpoint admin à la main.

## À livrer

- [ ] Cron (`/api/cron/oauth-failure-alert`, toutes les 5 min) ou webhook
      Grafana qui :
      - compte les rows `oauth_signin_events` avec `event='failure'` sur les
        5 dernières minutes (`created_at >= now() - 5min`)
      - si > 50 → envoie une alerte Telegram (token + chat id dans
        `~/credentials/.all-creds.env`)
- [ ] Anti-spam : ne pas re-alerter toutes les 5 min si le pic dure
      (cooldown 30 min, ou flag "déjà alerté").
- [ ] Test du seuil + du cooldown.

## Référence

- Table source : migration `20260522140000_add_oauth_signin_events`
- Endpoint de consultation : `app/api/admin/oauth-events/route.ts`
- CI-ARCHITECTURE §17.5 (webhook Grafana → rollback) : pattern alerting
- Pattern cron existant : `app/api/cron/trial-tick/`
