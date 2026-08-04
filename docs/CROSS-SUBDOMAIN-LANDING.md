# Landing CF Pages ↔ Hub — architecture cross-subdomain

> Statut : **côté Hub livré 2026-05-27**. Landing CF Pages à créer côté repo
> séparé (action Robert).
> Pattern : **2-cookies** (zéro downtime sessions, décision Robert 2026-05-27).

## Pourquoi 2 cookies

Premier essai 2026-05-27 (commit reverted) : scope cookie session sur
`.veridian.site`. Décision Robert : refus, car ça **invalide toutes les
sessions actives prod** au déploiement (le browser ne match plus l'ancien
cookie `app.veridian.site` avec le nouveau `.veridian.site`).

Solution retenue : **2 cookies séparés**.

| Cookie | Scope | HttpOnly | Rôle |
|---|---|---|---|
| `__Secure-authjs.session-token` | `app.veridian.site` (host) | ✅ oui | Authority — vraie session Auth.js. Inchangé, jamais touché. |
| `veridian-session-hint` | `.veridian.site` (apex + sous-dom.) | ❌ non | Hint UX cross-subdomain. JWT HS256 signé. Claims légers `{email, name?, image?}`. |

Le cookie session principal reste **sacré et inchangé**. Le cookie hint est
un indice UX pour la landing — pas une autorité de session.

## Architecture

```
                  ┌─────────────────────────────┐
                  │ veridian.site (CF Pages)    │
                  │  - HTML statique            │
                  │  - JS : lit cookie hint     │
                  │  - JS : Google One Tap GSI  │
                  │  - JS : fetch /api/me/lite  │
                  └────────┬────────────────────┘
                           │ fetch credentials:include
                           │  + Origin: https://veridian.site
                           ▼
                  ┌─────────────────────────────┐
                  │ app.veridian.site (Hub)     │
                  │  - GET /api/me/lite (CORS,  │
                  │      fast path hint cookie) │
                  │  - POST /api/auth/callback/ │
                  │      google-one-tap (CORS)  │
                  │  - POST /api/auth/          │
                  │      session-hint/refresh   │
                  │  - POST /api/auth/          │
                  │      session-hint/clear     │
                  │  - cookie session : scope   │
                  │      app.veridian.site      │
                  │  - cookie hint   : scope    │
                  │      .veridian.site         │
                  └─────────────────────────────┘
```

Le cookie hint est posé automatiquement :
- au **login OAuth standard** (Google/Microsoft) via un call client à
  `/api/auth/session-hint/refresh` après le retour callback (hook React)
- au **signup credentials** via le même call
- au **One Tap signup** depuis la landing (le callback `/api/auth/callback/
  google-one-tap` pose les 2 cookies en parallèle)
- en **bootstrap** sur `/api/me/lite` (si fallback Auth.js réussit, le hint
  est posé pour la prochaine visite)

Et clear automatiquement :
- avant le **signOut** Auth.js (call client à `/api/auth/session-hint/clear`)

## Composants côté Hub

### 1. `lib/auth/session-hint-cookie.ts` — helpers JWT signés

| Helper | Rôle |
|---|---|
| `encodeSessionHintJwt(claims, env?)` | Signe un JWT HS256 avec `SESSION_HINT_SECRET` |
| `decodeSessionHintJwt(token, env?)` | Vérifie sig + exp + issuer, retourne claims ou `null` (jamais throw) |
| `setSessionHintCookie(res, claims, env?)` | Pose le Set-Cookie cross-subdomain |
| `clearSessionHintCookie(res, env?)` | Set Max-Age=0 |
| `readSessionHintFromRequest(req, env?)` | Lit + valide le cookie depuis NextRequest |

Constantes exportées :
- `SESSION_HINT_COOKIE_NAME = 'veridian-session-hint'`
- `SESSION_HINT_TTL_S = 60 * 60 * 24 * 30` (30j)

Sécurité :
- HS256 signé via `SESSION_HINT_SECRET` (≥ 32 chars exigés)
- Issuer figé `'veridian-hub'` (anti-token recyclé d'un autre service)
- Pas de claims sensibles (pas userId, pas role) — vol cookie = pas takeover

### 2. `GET /api/me/lite` (CORS-enabled, fast path hint)

Endpoint principal pour la landing. Deux paths :

**Fast path** (la landing a déjà le hint cookie) :
```json
{
  "authenticated": true,
  "email": "robert@veridian.site",
  "name": "Robert",
  "image": "https://...",
  "source": "hint"
}
```
Pas de DB hit, pas de JWE decode. Latence ~1 ms.

**Fallback Auth.js** (pas de hint mais session valide) :
```json
{
  "authenticated": true,
  "email": "robert@veridian.site",
  "name": "Robert",
  "image": "https://...",
  "source": "session"
}
```
Best-effort : pose le hint cookie en passant pour la prochaine visite
(bootstrap idempotent).

**Pas de session** :
```json
{ "authenticated": false }
```

Toujours 200 — la landing n'a pas à gérer un 401.

**CORS** : Origin doit être whitelistée (`lib/cors/landing-cors.ts`).
Rate-limit 100 req/min/IP.

### 3. `POST /api/auth/callback/google-one-tap` (CORS-enabled)

Endpoint One Tap appelé depuis la landing. Valide le JWT Google, bootstrap
user, pose le cookie session principal **ET** le cookie hint en parallèle.

**Request** (depuis la landing) :
```js
google.accounts.id.initialize({
  client_id: 'YOUR_GOOGLE_OAUTH_CLIENT_ID',
  callback: async ({ credential }) => {
    const res = await fetch(
      'https://app.veridian.site/api/auth/callback/google-one-tap',
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      },
    );
    const data = await res.json();
    if (data.ok) {
      window.location.href = 'https://app.veridian.site' + data.redirect;
    }
  },
});
google.accounts.id.prompt();
```

**Response success** :
```json
{
  "ok": true,
  "redirect": "/dashboard",
  "authenticated": true,
  "email": "robert@veridian.site",
  "name": "Robert",
  "image": "https://...",
  "freshlyCreated": false
}
```

Rate-limit 30/min/IP. 503 en staging (One Tap désactivé Tailscale-only).

### 4. `POST /api/auth/session-hint/refresh` (auth required)

Permet à un user déjà loggué côté Hub (via OAuth/credentials/magic link)
de **bootstrap** son cookie hint pour la landing. À câbler dans un hook
React côté dashboard layout :

```tsx
useEffect(() => {
  if (status === 'authenticated') {
    fetch('/api/auth/session-hint/refresh', { method: 'POST' }).catch(() => {});
  }
}, [status]);
```

**Sans auth** → 401. **Sans SESSION_HINT_SECRET** → 500 misconfigured.

### 5. `POST /api/auth/session-hint/clear` (public)

Clear le cookie hint. À câbler avant le `signOut()` Auth.js :

```tsx
async function handleSignOut() {
  await fetch('/api/auth/session-hint/clear', { method: 'POST' }).catch(() => {});
  await signOut();
}
```

Public et idempotent (200 toujours).

### 6. Microsoft (PAS de One Tap natif)

Microsoft Entra n'a pas d'équivalent One Tap. Côté landing → bouton classique :

```html
<a href="https://app.veridian.site/api/auth/signin/microsoft?callbackUrl=https://app.veridian.site/dashboard">
  Continuer avec Microsoft
</a>
```

Le flow OAuth standard redirige vers Microsoft puis revient sur app.veridian.site.
Le cookie session est posé scope `app.veridian.site`. Le hint sera bootstrap
au prochain hit de `/api/me/lite` depuis la landing OU au prochain visit
dashboard via le hook React.

### 7. Email / Signup (PAS de One Tap)

Mêmes URLs que les flows existants :

```html
<a href="https://app.veridian.site/signup">Créer un compte</a>
<a href="https://app.veridian.site/login">Se connecter</a>
```

## CORS — whitelist Hub

Origins acceptées sur les routes cross-subdomain (cf. `lib/cors/landing-cors.ts`) :

**Toujours acceptés** (hardcoded) :
- `https://veridian.site`
- `https://www.veridian.site`

**Ajoutés via ENV `LANDING_ORIGIN`** (prod) — ex `https://veridian.io`
**Ajoutés via ENV `LANDING_ORIGIN_STAGING`** (staging only)
**En local-dev** : `http://localhost:3000`, `http://localhost:4321`, `http://localhost:5173`

## Snippets prêts à coller côté landing

### Détection session — lecture cookie hint (sync, sans réseau)

```html
<script>
  function readHintCookie() {
    const match = document.cookie.match(/(?:^|;\s*)veridian-session-hint=([^;]+)/);
    if (!match) return null;
    try {
      const parts = match[1].split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.exp && payload.exp * 1000 < Date.now()) return null;
      return { email: payload.email, name: payload.name, image: payload.image };
    } catch { return null; }
  }

  const hint = readHintCookie();
  if (hint) {
    document.body.dataset.user = hint.email;
    document.querySelectorAll('[data-show-when-logged-in]')
      .forEach(el => el.style.display = '');
    document.querySelectorAll('[data-show-when-logged-out]')
      .forEach(el => el.style.display = 'none');
    document.querySelectorAll('[data-user-email]')
      .forEach(el => el.textContent = hint.email);
  }
</script>

<a href="https://app.veridian.site/dashboard"
   data-show-when-logged-in
   style="display:none">
  Accéder au dashboard
</a>

<button data-show-when-logged-out onclick="loginWithOneTap()">
  Se connecter
</button>
```

⚠️ La lecture cookie côté JS **ne vérifie pas la signature** — un user
malveillant peut éditer son propre cookie pour faire croire à sa propre
landing "je suis admin@". Mais la signature est vérifiée côté Hub à
chaque appel d'API protégée → aucun risque d'élévation de privilège. Le
JS n'utilise le hint que pour l'UX (afficher email/avatar).

### Détection session — via API (signature vérifiée serveur)

Pour une UX qui dépend de la signature, passer par `/api/me/lite` :

```js
fetch('https://app.veridian.site/api/me/lite', { credentials: 'include' })
  .then(r => r.json())
  .then(data => {
    if (data.authenticated) {
      console.log(data.source); // 'hint' ou 'session'
    }
  });
```

### Google One Tap

```html
<script src="https://accounts.google.com/gsi/client" async></script>
<script>
  async function loginWithOneTap() {
    window.google.accounts.id.initialize({
      client_id: 'YOUR_GOOGLE_OAUTH_CLIENT_ID',
      callback: async ({ credential }) => {
        const res = await fetch(
          'https://app.veridian.site/api/auth/callback/google-one-tap',
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential }),
          },
        );
        const data = await res.json();
        if (data.ok) {
          window.location.href = 'https://app.veridian.site' + data.redirect;
        }
      },
    });
    window.google.accounts.id.prompt();
  }
</script>
```

## Checklist déploiement landing (futur)

1. **Générer le secret hint** : `openssl rand -base64 48` → poser
   `SESSION_HINT_SECRET` dans la Nomad Variable nomad/jobs/hub (template env) + `~/credentials/.all-creds.env`
2. **DNS** : ajouter `veridian.site` → CF Pages
3. **CF Pages** : déployer le repo landing
4. **OAuth Google Cloud Console** : ajouter `https://veridian.site` dans les
   **Authorized JavaScript origins** du Client OAuth (PAS dans Authorized
   redirect URIs — One Tap ne redirect pas)
5. **Câbler le hook React côté dashboard layout** :
   ```tsx
   import { useEffect } from 'react';
   import { useSession } from 'next-auth/react';
   export function useSessionHintRefresh() {
     const { status } = useSession();
     useEffect(() => {
       if (status === 'authenticated') {
         fetch('/api/auth/session-hint/refresh', { method: 'POST' }).catch(() => {});
       }
     }, [status]);
   }
   ```
6. **Câbler `clear` avant signOut** :
   ```tsx
   async function signOutWithHintClear() {
     await fetch('/api/auth/session-hint/clear', { method: 'POST' }).catch(() => {});
     await signOut();
   }
   ```
7. **Tester depuis la landing** :
   - sans cookie hint → `/api/me/lite` 200 `{authenticated:false}`
   - après login côté app → cookie hint visible dans devtools
   - depuis veridian.site → lecture cookie hint JS OK + `/api/me/lite` 200 `{source:'hint'}`
   - One Tap → cookie hint posé + redirect dashboard

## Sécurité — points d'attention

- **2 cookies séparés** : le hint est public-ish (lisible JS), le session
  reste httpOnly (résistant XSS). Pas de claims sensibles dans le hint.
- **Signature HS256** : empêche un attaquant d'éditer le hint pour faire
  croire à la landing "je suis X". Côté JS la lecture n'est qu'UX — toute
  action protégée appelle le Hub qui re-vérifie la signature.
- **Secrets distincts** : `SESSION_HINT_SECRET` ≠ `AUTH_SECRET`. Rotation
  indépendante, blast radius isolé.
- **CORS avec credentials** : on echo l'origin (jamais `*`) parce que
  `Access-Control-Allow-Credentials: true` interdit le wildcard. Whitelist
  stricte (string exact match).
- **One Tap GSI** : Google valide aussi l'origin côté client (GSI refuse
  d'afficher la popup si l'origin n'est pas dans Authorized JavaScript
  origins du Client OAuth). Double défense.
- **Désactivé en staging** : `/api/auth/callback/google-one-tap` retourne
  503 quand `DEPLOY_ENV=staging` (cohérent avec `isGoogleOneTapEnabled()`).

## Tests

- **Unit Vitest (~95 tests neufs)** :
  - `__tests__/lib/auth/cookie-scope.test.ts` (10 tests — refonte post-pivot)
  - `__tests__/lib/auth/session-hint-cookie.test.ts` (~20 tests — encode/decode,
    defenses, set/clear, read)
  - `__tests__/lib/cors/landing-cors.test.ts` (16 tests)
  - `__tests__/api/me/lite.test.ts` (~14 tests — fast path hint + fallback
    Auth.js + bootstrap + leak-proof + CORS + 429)
  - `__tests__/api/auth/session-hint/refresh.test.ts` (4 tests)
  - `__tests__/api/auth/session-hint/clear.test.ts` (2 tests)
  - `__tests__/api/auth/callback/google-one-tap.test.ts` (16 tests)
  - `__tests__/config/auth.test.ts` : test structural inversé qui
    REFUSE désormais tout `cookies: { sessionToken: ... domain: ... }`

- **E2E Playwright** :
  - `e2e/staging-full/18-cross-subdomain-landing.spec.ts` — preflight CORS,
    `/api/me/lite` non-auth, rejet origin non whitelistée, 503 staging
    one-tap.
