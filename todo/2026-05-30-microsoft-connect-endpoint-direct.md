# Endpoint /api/microsoft/connect (flow OAuth Microsoft direct, miroir Gmail)

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-30
> **Demandé par** : agent notifuse-veridian (Robert)

## Contexte

Notifuse a basculé le bouton "Connect Gmail" en flow DIRECT : il pointe sur
`app.veridian.site/api/gmail/connect?return=<notifuse>` → l'utilisateur arrive
directement sur l'écran de consent Google, sans page Hub intermédiaire, puis
rebondit dans Notifuse.

Pour **Microsoft**, ce n'est pas possible aujourd'hui : il n'existe **pas**
d'endpoint `/api/microsoft/connect` côté Hub (seul `/api/gmail/connect` existe).
Le bouton Microsoft de Notifuse reste donc sur l'ancien chemin (page Hub
`/dashboard/settings/mail?provider=microsoft`).

## Demande

Créer `app/api/microsoft/connect/route.ts` (+ callback) en **miroir exact** de
`app/api/gmail/connect/route.ts` :
- `getCurrentUser()` → redirect /login si pas de session
- state CSRF cookie + `return` validé via `validateReturnUrl` (allowlist apps,
  déjà en place côté oauth-cookies.ts)
- 302 vers le consent Microsoft (scope mail send), access offline
- callback : échange code → tokens, upsert Account provider='microsoft',
  email mismatch guard, rebond vers `return?mail_status=connected`

Réutiliser au maximum `lib/mail/oauth-cookies.ts` (STATE_COOKIE, RETURN_COOKIE,
validateReturnUrl, buildReturnRedirect) — déjà factorisés pour Gmail.

## Impact côté Notifuse (quand livré)

Notifuse fera pointer le bouton Microsoft sur `/api/microsoft/connect?return=...`
(même pattern que Gmail) → flow direct sans page Hub. Cf.
`notifuse-veridian/console/src/components/settings/veridian_mail_account_settings.tsx`
fonction `buildHubConnectUrl` (branche `provider === 'microsoft'`).

## Priorité

P2 : Gmail (cas principal) est déjà en flow direct. Microsoft fonctionne via
la page Hub en attendant — dégradé acceptable, pas bloquant.
