# Landing CF Pages ↔ Hub — architecture cross-subdomain

> Statut : **côté Hub livré 2026-05-27**. Landing CF Pages à créer côté repo
> séparé (action Robert).
> Tier risque : 🔴 HAUT (touche au scope cookie session — invalide les sessions
> actives au déploiement).

## Pourquoi

Robert veut séparer la landing marketing (statique, ultra-rapide, SEO-friendly)
du Hub applicatif (Next.js + DB + auth). Le compromis cible :

| Surface | Aujourd'hui | Cible |
|---|---|---|
| Landing marketing | `app.veridian.site/` (rendue par le Hub) | `veridian.site/` (CF Pages statique) |
| Dashboard + auth | `app.veridian.site/dashboard` + `/login` | inchangé |

Pendant la transition les **2 domaines doivent fonctionner**. Le commit qui
introduit ce setup côté Hub ne supprime PAS la landing actuelle sur
`app.veridian.site/` — il ouvre juste la porte CORS + cookie scope pour que
veridian.site puisse plug-and-play quand le repo landing sera prêt.

## Architecture

```
                  ┌─────────────────────────────┐
                  │ veridian.site (CF Pages)    │
                  │  - HTML statique            │
                  │  - JS : fetch /api/me/lite  │
                  │  - JS : Google One Tap GSI  │
                  └────────┬────────────────────┘
                           │ fetch credentials:include
                           │  + Origin: https://veridian.site
                           ▼
                  ┌─────────────────────────────┐
                  │ app.veridian.site (Hub)     │
                  │  - GET /api/me/lite (CORS)  │
                  │  - POST /api/auth/callback/ │
                  │      google-one-tap (CORS)  │
                  │  - cookie session scopé     │
                  │      .veridian.site         │
                  └─────────────────────────────┘
```

Le cookie session Auth.js est posé avec `Domain=.veridian.site` (cf.
`lib/auth/cookie-scope.ts`) donc visible depuis l'apex ET tout sous-domaine.

## Composants côté Hub

### 1. Cookie scope `.veridian.site`

Configuré dans `auth.ts` via `resolveSessionCookieConfig()`. Règle :

| `DEPLOY_ENV` | `Domain` | Cookie visible depuis |
|---|---|---|
| `prod` | `.veridian.site` | veridian.site, www.veridian.site, app.veridian.site, *.veridian.site |
| `staging` | `.staging.veridian.site` | hub.staging.veridian.site, futur veridian.staging.site |
| (dev/local) | (non posé) | host courant (localhost) |

**Impact déploiement** : le passage de scope `app.veridian.site` → `.veridian.site`
invalide les sessions actives au moment du déploiement (le browser ne
matche plus l'ancien cookie). Les utilisateurs devront re-login. Notification
côté UI conseillée (banner sur /login pendant 24h post-deploy).

### 2. `GET /api/me/lite` (CORS-enabled)

Endpoint **lite** que la landing call en début de page pour détecter une
session existante.

**Request** (depuis la landing) :
```js
const res = await fetch('https://app.veridian.site/api/me/lite', {
  credentials: 'include',
});
const { authenticated, email, name, image } = await res.json();
```

**Response** :
```json
{ "authenticated": false }
```
ou :
```json
{
  "authenticated": true,
  "email": "robert@veridian.site",
  "name": "Robert",
  "image": "https://..."
}
```

Toujours 200 — la landing n'a pas à gérer un 401. Volontairement **lite** :
pas de userId, pas de role, pas de plan (la landing ne pilote pas le SaaS).

**CORS** : Origin doit être dans la whitelist (`lib/cors/landing-cors.ts`).
Origin non whitelistée → la réponse sort sans `Access-Control-Allow-Origin`,
le browser bloque côté landing (le fetch rejette).

**Rate-limit** : 100 req/min/IP.

### 3. `POST /api/auth/callback/google-one-tap` (CORS-enabled)

Endpoint que la landing call avec le `id_token` JWT renvoyé par le widget
Google One Tap.

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
      // Cookie session posé — redirige vers le dashboard
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

**Response erreurs** :
- `400 invalid_body` — credential absent ou JSON cassé
- `401 invalid_token` — JWT rejeté (signature, exp, aud, email non vérifié)
- `429 rate_limited` — 30+ tentatives/min/IP
- `500 misconfigured` — `AUTH_SECRET` absent
- `503 disabled` — `GOOGLE_OAUTH_CLIENT_ID` absent OU `DEPLOY_ENV=staging`

**Rate-limit** : 30 req/min/IP (via `oauthCallbackLimiter` existant).

### 4. Microsoft (PAS de One Tap natif)

Microsoft Entra n'a pas d'équivalent One Tap. Côté landing → bouton classique :

```html
<a href="https://app.veridian.site/api/auth/signin/microsoft?callbackUrl=https://app.veridian.site/dashboard">
  Continuer avec Microsoft
</a>
```

Le flow OAuth standard redirige vers Microsoft puis revient sur app.veridian.site.
Le cookie session est posé avec scope `.veridian.site` → au prochain visit de
veridian.site, `/api/me/lite` renverra `authenticated: true`.

### 5. Email / Signup (PAS de One Tap)

Mêmes URLs que les flows existants — la landing redirige vers app.veridian.site
qui gère le form complet :

```html
<a href="https://app.veridian.site/signup">Créer un compte</a>
<a href="https://app.veridian.site/login">Se connecter</a>
```

## CORS — whitelist Hub

Origins acceptées sur les routes cross-subdomain (cf. `lib/cors/landing-cors.ts`) :

**Toujours acceptés** (hardcoded) :
- `https://veridian.site`
- `https://www.veridian.site`

**Ajoutés via ENV `LANDING_ORIGIN`** (prod) :
- Ex : `https://veridian.io` si rebrand domaine

**Ajoutés via ENV `LANDING_ORIGIN_STAGING`** (staging only) :
- Futur : `https://veridian.staging.site` quand landing aura un staging dédié

**En local-dev** (`DEPLOY_ENV` absent) :
- `http://localhost:3000`, `http://localhost:4321`, `http://localhost:5173`
  (facilite le dev cross-port d'une landing Astro/Vite/etc.)

## Snippets prêts à coller côté landing

### Détection session (start of page)

```html
<script>
  fetch('https://app.veridian.site/api/me/lite', { credentials: 'include' })
    .then(r => r.json())
    .then(data => {
      if (data.authenticated) {
        document.body.dataset.user = data.email;
        document.querySelectorAll('[data-show-when-logged-in]')
          .forEach(el => el.style.display = '');
        document.querySelectorAll('[data-show-when-logged-out]')
          .forEach(el => el.style.display = 'none');
      }
    })
    .catch(() => { /* offline / CORS / pas grave, fallback logged-out UI */ });
</script>

<a href="https://app.veridian.site/dashboard"
   data-show-when-logged-in
   style="display:none">
  Accéder au dashboard
</a>

<button data-show-when-logged-out
        onclick="loginWithOneTap()">
  Se connecter
</button>
```

### Google One Tap

```html
<script src="https://accounts.google.com/gsi/client" async></script>
<script>
  async function loginWithOneTap() {
    window.google.accounts.id.initialize({
      client_id: 'YOUR_GOOGLE_OAUTH_CLIENT_ID', // == Hub GOOGLE_OAUTH_CLIENT_ID
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

Quand le repo landing CF Pages sera prêt :

1. **DNS** : ajouter `veridian.site` → CF Pages (CNAME ou flat).
2. **Cloudflare Pages** : déployer le repo landing, brancher domaine custom.
3. **Côté Hub** : poser `LANDING_ORIGIN=https://veridian.site` dans Dokploy
   ENV prod (déjà whitelist hardcoded mais explicite = mieux).
4. **OAuth Google Cloud Console** : ajouter `https://veridian.site` dans les
   **Authorized JavaScript origins** du Client ID OAuth (le widget GSI le
   vérifie). PAS besoin d'ajouter à Authorized redirect URIs (One Tap ne
   redirect pas).
5. **Tester côté landing** :
   - `/api/me/lite` sans cookie → `{authenticated:false}` (200 + CORS header)
   - `/api/me/lite` avec cookie (logué sur app.veridian.site) → claims
   - One Tap signup → cookie posé, dashboard accessible.
6. **Migrer le contenu marketing** progressivement de
   `app.veridian.site/(marketing)/*` vers `veridian.site/*`. Tant que
   `app.veridian.site/` continue à servir la landing legacy, pas de
   discontinuité utilisateur.
7. **Quand veridian.site est stable** : supprimer la landing
   `app.veridian.site/(marketing)/*` (commit séparé, tier 🔴 HAUT — purge
   SEO).

## Sécurité — points d'attention

- **Cookie scope `.veridian.site`** : tout sous-domaine *.veridian.site lit
  le cookie. Si on délègue un sous-domaine à un service tiers (Vercel,
  Netlify, etc.), ce service pourrait lire le cookie. **Ne jamais déléguer
  *.veridian.site à un tiers** sans audit.
- **CORS avec credentials** : on echo l'origin (jamais `*`) parce que
  `Access-Control-Allow-Credentials: true` interdit le wildcard. La
  whitelist est stricte (string exact match) — pas de regex laxiste.
- **One Tap GSI** : Google valide aussi l'origin côté client (GSI refuse
  d'afficher la popup si l'origin n'est pas dans les Authorized JavaScript
  origins du Client OAuth). Double défense.
- **Désactivé en staging** : la route `/api/auth/callback/google-one-tap`
  retourne 503 quand `DEPLOY_ENV=staging` (cohérent avec le provider
  Auth.js, cf. `isGoogleOneTapEnabled()`). Staging est Tailscale-only,
  pas de redirect URI / origin déclaré chez Google.

## Tests

- **Unit Vitest** :
  - `__tests__/lib/auth/cookie-scope.test.ts` — 12 tests (scope par env,
    nom préfixé `__Secure-`)
  - `__tests__/lib/cors/landing-cors.test.ts` — 16 tests (whitelist,
    ENV invalides, Vary, preflight)
  - `__tests__/api/me/lite.test.ts` — 12 tests (auth on/off, leak-proof,
    CORS, rate-limit)
  - `__tests__/api/auth/callback/google-one-tap.test.ts` — 16 tests
    (garde-fous, JWT, signup/login, cookie scope, CORS, rate-limit)

- **E2E Playwright** :
  - `e2e/staging-full/cross-subdomain-landing.spec.ts` — preflight CORS,
    `/api/me/lite` non-auth, rejet origin non whitelistée.
