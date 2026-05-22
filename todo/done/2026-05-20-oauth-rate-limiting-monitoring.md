# [HUB] Rate limiting + monitoring routes OAuth

> **Type** : Sécurité + observabilité
> **Sévérité** : 🟡 P2 (pas urgent tant que trafic faible, devient critique à scale)
> **Owner** : agent Hub
> **Créé** : 2026-05-20
> **🟡 LIVRÉ PARTIELLEMENT** : 2026-05-20 (commit `f0daf44`)
>
> **✅ Phase 1 livrée** :
> - Rate limiter IP-based in-memory (`lib/auth/rate-limit.ts`) :
>     * 10 req/min/IP sur `/api/auth/signin*`
>     * 30 req/min/IP sur `/api/auth/callback*`
>     * Autres routes Auth.js (`/session`, `/csrf`, `/providers`) NON limitées
> - Wrap des handlers Auth.js avec 429 + Retry-After header
> - Logger structuré `[auth-error][critical]` sur Configuration et
>   OAuthCallbackError (déjà livré dans le commit error-banner via `auth.ts`
>   logger override — JSON stderr, prêt pour pipeline Grafana Loki)
> - 22 tests vitest (382/382 vert)
> - Smoke prod validé : `/signin x12` → 10× 302 puis 429 dès la 11e
>
> **✅ Phases 2-3 livrées** : 2026-05-22 (sprint backend Hub, Lot 1)
> - Table `hub_app.oauth_signin_events` (migration `20260522140000`)
> - Logger `lib/auth/oauth-event-log.ts` câblé sur succès (event `signIn`
>   Auth.js) ET échec (override `logger.error` — OAuthCallbackError /
>   Configuration / OAuthSignInError / OAuthAccountNotLinked / AccessDenied)
> - Endpoint admin `GET /api/admin/oauth-events` — paginé keyset, filtres
>   `?provider= ?event= ?email=`, protégé `authenticateAdmin()` + rate-limit
> - 25 tests vitest (oauth-event-log + oauth-events route)
>
> **⏳ Reste à faire** (hors scope ce ticket — à découpler) :
> - Alerting Telegram via cron Grafana ou webhook si > 50 callback
>   failures Hub en 5 min
> - Migration `console.log` → Pino partout (gros refactor, à découpler)

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
