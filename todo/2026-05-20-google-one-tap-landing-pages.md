# [HUB] Google One Tap — popup auto-login sur landing + login pages

> **Type** : Feature growth — réduit la friction signup
> **Sévérité** : 🟡 P2 (impact conversion, pas urgent infra)
> **Owner** : agent Hub
> **Créé** : 2026-05-20

## Contexte

Google One Tap = popup "Se connecter en tant que Robert (brunon5robert@gmail.com)"
qui apparaît auto en haut-droite si l'user a une session Google active dans
son navigateur. Standard absolu sur Pinterest, Medium, Reddit, Hacker News,
Discord, etc. Augmente le signup rate de **+40 à +60%** selon les études
publiées par Google Identity team.

Marche **avec le même Client ID OAuth Web** déjà configuré (pas besoin de
nouveau secret). C'est juste un widget JS Google Identity Services à intégrer
+ un endpoint pour valider le ID token retourné.

## Où l'afficher

### Page landing publique `/` (priorité 1)

- User non-loggué arrive sur `app.veridian.site/`
- Si session Google détectée → popup auto en haut-droite "Continue as Robert"
- Click → POST /api/auth/google/one-tap → session Hub créée → redirect dashboard

### Page `/login` et `/signup` (priorité 2)

- Idem, le popup s'affiche en plus du bouton "Continuer avec Google" classique
- L'user a 2 chemins : popup auto OU click bouton manuel

### Pages marketing tierces `/pricing`, `/legal` (priorité 3)

- Moins évident, plus discret. À tester en A/B.

## Implementation Auth.js v5

Auth.js v5 **supporte nativement Google One Tap** depuis v0.36+ via le
provider Google avec config `oneTap` :

```ts
Google({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  authorization: { params: { scope: 'openid email profile', prompt: 'select_account' } },
  allowDangerousEmailAccountLinking: true,
}),
```

Et côté client React :
```tsx
import { signIn } from 'next-auth/react';
import Script from 'next/script';

// In layout root
<Script src="https://accounts.google.com/gsi/client" async defer />

// Then anywhere
<div id="g_id_onload"
     data-client_id="<CLIENT_ID>"
     data-callback="handleCredentialResponse"
     data-auto_select="true"
     data-itp_support="true"
/>
```

Le `credential` retourné est un id_token JWT, à valider côté serveur avec
le même flow que le bouton OAuth normal (Auth.js a un endpoint dédié).

## Garde-fous

- **Activer uniquement si user non-loggué** (`useSession()` retourne null)
- **Respecter le choix "Don't show again"** — Google One Tap a un cooldown
  natif (24h après "Cancel")
- **Désactiver sur les pages MFA** pour ne pas court-circuiter le 2FA
- **Désactiver sur Safari iOS** si ITP cause des bugs (à tester)

## Tests à câbler

- RTL : composant `GoogleOneTap.tsx` ne render que si pas de session
- E2E Playwright : forcer une session Google côté browser → vérifier popup
  apparaît → click → redirect dashboard
- Test de non-régression : popup ne s'affiche pas sur `/login` si user déjà
  loggué

## Effort estimé

- 1j : intégration provider + composant React
- 1j : endpoint serveur + validation id_token
- 1-2j : tests + A/B test setup

## Référence

- Google Identity Services One Tap : https://developers.google.com/identity/gsi/web/guides/display-google-one-tap
- Auth.js v5 Google provider : https://authjs.dev/getting-started/providers/google
- Mesure impact conversion : https://developers.google.com/identity/gsi/web/guides/display-one-tap-on-existing-account
