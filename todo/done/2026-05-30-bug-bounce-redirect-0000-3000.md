# Bug 🔴 — bounce OAuth redirige vers `https://0.0.0.0:3000/...` (cassé en prod)

> **Sévérité** : 🔴 P0 (le SSO cross-app depuis les apps downstream est totalement cassé)
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-30
> **Déposé par** : agent veridian-prospection (diagnostic complet ci-dessous)

## Symptôme

Depuis une app downstream (ex Prospection), cliquer "Continuer avec
Google/Microsoft" → le bouton fait `window.location.href = app.veridian.site/login?next=<app_url>`.
Au lieu d'afficher le login Hub, le navigateur atterrit sur
`https://0.0.0.0:3000/login` (page morte, SSL wrong version).

**Le login Hub direct (sans `?next=`) marche** : Google + Microsoft OK.
Seul le flow **bounce** (`?next=`) est cassé.

## Repro (prod, curl)

```
$ curl -sI "https://app.veridian.site/login?next=https%3A%2F%2Fprospection.app.veridian.site%2Flogin"
HTTP/2 307
location: /api/auth/bounce/prepare?next=https%3A%2F%2Fprospection.app.veridian.site%2Flogin   ✅ OK

$ curl -sI "https://app.veridian.site/api/auth/bounce/prepare?next=https%3A%2F%2Fprospection.app.veridian.site%2Flogin"
HTTP/2 307
location: https://0.0.0.0:3000/login                                                            ❌ BUG

$ curl -sI "https://app.veridian.site/api/auth/bounce/complete"
HTTP/2 307
location: https://0.0.0.0:3000/dashboard                                                        ❌ BUG (même cause)
```

## Cause racine

Les route handlers `app/api/auth/bounce/prepare/route.ts` et
`app/api/auth/bounce/complete/route.ts` construisent TOUS leurs redirects
avec `new URL('/login', req.url)` / `new URL('/dashboard', req.url)`.

Derrière Traefik, `req.url` exposé dans un Route Handler Next.js vaut
`https://0.0.0.0:3000/...` (adresse de bind interne du container), PAS
l'URL publique. Donc `new URL('/login', req.url)` → `https://0.0.0.0:3000/login`.

Pourquoi le login Hub direct marche quand même : Auth.js compose ses
propres URLs via `trustHost: true` + lecture des headers `x-forwarded-*`
(le cookie `__Secure-authjs.callback-url=https://app.veridian.site` posé
par prepare est d'ailleurs CORRECT). Mais le code manuel des route
handlers bounce ne passe PAS par Auth.js — il fait du `new URL(..., req.url)`
brut qui hérite du host interne.

## Fix demandé

Dans `bounce/prepare/route.ts` ET `bounce/complete/route.ts`, dériver la
base URL des headers de proxy au lieu de `req.url`. Pattern déjà utilisé
côté Prospection (`src/app/api/auth/token/route.ts:baseUrlFromRequest`) :

```ts
function publicBaseUrl(req: NextRequest): string {
  // En prod/staging derrière Traefik, AUTH_URL est la source de vérité.
  const envUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  // Fallback headers proxy
  const host =
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}
```

Puis remplacer chaque `new URL('/path', req.url)` par
`new URL('/path', publicBaseUrl(req))` dans les deux handlers.

⚠️ Vérifier `AUTH_URL` / `NEXTAUTH_URL` dans l'ENV du compose Hub prod
(Dokploy composeId `_kxAHDCv1LhvsdwNRX3Vk`) : si l'une est définie à
`https://app.veridian.site`, le `envUrl` la prend direct, propre et fiable.
C'est l'option la plus robuste — vérifier qu'elle est bien posée.

## Tests à ajouter / vérifier

- Un test unitaire sur les deux handlers qui simule un `req` avec
  `x-forwarded-host: app.veridian.site` + `req.url = http://0.0.0.0:3000/...`
  et assert que le `Location` de la réponse est bien sur `app.veridian.site`.
- E2E mega `H-02-oauth-bounce-couche4.spec.ts` : vérifier qu'il teste le
  Location réel du redirect prepare (sinon il a laissé passer ce bug —
  il doit tourner contre un host proxifié, pas localhost).

## Impact côté Prospection

Aucune modif Prospection nécessaire — son code est sain (boutons bounce,
`/api/sso/issue-magic-link`, `/api/auth/token` tous corrects). Une fois
le Hub fixé, le flow complet (prepare → OAuth → complete →
issue-magic-link → token) fonctionnera de bout en bout.
