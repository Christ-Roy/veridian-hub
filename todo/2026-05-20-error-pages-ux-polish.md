# [HUB] Custom error pages pour OAuth + auth flow

> **Type** : Polish UX
> **Sévérité** : 🟢 P3 (cosmetic, mais user-visible)
> **Owner** : agent Hub
> **Créé** : 2026-05-20

## Contexte

Auth.js v5 redirige les erreurs OAuth vers `/login?error=<code>` avec un set
d'erreurs standardisées. Aujourd'hui le `LoginForm.tsx` ne render rien de
spécial pour ces codes — le user voit juste le form normal avec un toast
d'erreur générique.

Codes Auth.js à gérer (cf. https://authjs.dev/reference/core/errors) :
- `OAuthAccountNotLinked` (~résolu via `allowDangerousEmailAccountLinking`, mais d'autres providers futurs pourront retourner)
- `OAuthCallbackError`
- `OAuthSigninError`
- `Configuration` (provider mal configuré côté serveur)
- `AccessDenied` (user a cliqué "Cancel" sur le consent screen)
- `Verification` (token magic link expiré)
- `Default` (catch-all)

## À faire

- [ ] Composant `LoginErrorBanner.tsx` qui mappe les codes à des messages
      user-friendly français + CTA approprié
- [ ] Intégrer dans `LoginForm.tsx` + `SignupForm.tsx`
- [ ] Logger côté serveur (Hub Analytics ou Telegram) quand `Configuration`
      ou `OAuthCallbackError` arrive — signal d'incident côté provider
- [ ] Tests RTL : pour chaque code d'erreur, vérifier le message rendu
- [ ] E2E : forcer une `?error=AccessDenied` puis vérifier rendu

## Référence

- Codes Auth.js : https://authjs.dev/reference/core/errors
- Ticket parent OAuth : `todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md`
- Scénarios OAuth non couverts (L) : `todo/2026-05-20-oauth-scenarios-coverage.md`
