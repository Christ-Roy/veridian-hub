# [HUB] Rate limiting + monitoring routes OAuth

> **Type** : Sécurité + observabilité
> **Sévérité** : 🟡 P2 (pas urgent tant que trafic faible, devient critique à scale)
> **Owner** : agent Hub
> **Créé** : 2026-05-20

## Contexte

OAuth Sign-in Hub livré 2026-05-20 (Google + Microsoft) sans rate limiting ni
monitoring spécifique. Phase 1.F du ticket OAuth principal :

> - Rate limiting sur `/api/auth/*/start` : 10 req/min/IP
> - Rate limiting sur `/api/auth/*/callback` : 30 req/min/IP
> - Logging structuré : success/failure avec provider, email, IP, user_agent
> - Audit table `hub_app.oauth_signin_events`
> - Alerting Telegram si > 50 callback failures / 5 min

Aucun n'est câblé aujourd'hui. Pas urgent (trafic bas), mais à câbler avant
le passage en "In production" Google ou si on ouvre publiquement aux users.

## À livrer

- [ ] Middleware rate limit IP sur `/api/auth/[...nextauth]` (réutilise le
      pattern existant `app/api/auth/mfa/resend/route.ts` qui retourne 429)
- [ ] Logger structuré (Pino ou log JSON) sur succès/échec OAuth avec :
      `{ event, provider, email, ip, user_agent, error_code, duration_ms }`
- [ ] Table `hub_app.oauth_signin_events` (à créer via migration Prisma)
- [ ] Cron Grafana ou Telegram alerting :
      "Alerte si > 50 callback failures Hub en 5 min"

## Pré-requis

- Logger : aujourd'hui Hub utilise `console.log`/`console.error`. Migrer
  d'abord vers un logger structuré (Pino + transport Grafana Loki) — c'est
  un chantier en soi, à découpler.

## Effort estimé

- 1j rate limiting (Redis-based ou in-memory Map)
- 2j logger structuré (touche tout le code → gros refactor)
- 1j table audit + endpoint admin de consultation
- 1j alerting

**Total** : 5j

## Référence

- Phase 1.F du ticket OAuth : `todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md`
- CI-ARCHITECTURE §17.5 (webhook Grafana → rollback) : pattern alerting
- Pattern MFA resend rate limit : `app/api/auth/mfa/resend/route.ts:37`
