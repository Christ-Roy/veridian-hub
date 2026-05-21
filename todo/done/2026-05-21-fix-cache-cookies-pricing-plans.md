# Fix cache : set-cookie Auth.js casse le cache CDN sur /api/pricing/plans

> **Sévérité** : 🟡 P1
> **Owner** : agent Hub
> **Créé** : 2026-05-21
> **Source** : `todo/2026-05-21-audit-perf-hub.md` §4.2

## Problème

`/api/pricing/plans` est configurée correctement côté Next.js :

```typescript
export const dynamic = 'force-static';
export const revalidate = 3600;
```

Et le cache HTTP est correctement déclaré :

```
Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400
x-nextjs-cache: HIT
```

**MAIS** la réponse contient aussi :

```
set-cookie: __Host-authjs.csrf-token=...; Path=/; HttpOnly; Secure; SameSite=Lax
set-cookie: __Secure-authjs.callback-url=...; Path=/; HttpOnly; Secure; SameSite=Lax
```

Ces cookies sont injectés par le middleware Auth.js, qui matche tout
`/api/*` par défaut. **RFC 7234 §3 + comportement Cloudflare/Traefik/Varnish** :
`Set-Cookie` + `Cache-Control: public` ⇒ **cache désactivé en edge**.

## Conséquence

Chaque hit à `/api/pricing/plans` traverse :
1. CDN (cache miss à cause de Set-Cookie)
2. Reverse proxy Traefik
3. Container Next.js
4. Cache ISR interne (HIT → réponse instantanée)

Latence finale observée en staging : **~200ms P50, ~600ms P95**. Avec le
cache edge actif, on serait à ~20ms (juste le RTT CDN).

Ce endpoint est consommé par **Notifuse** (boot, TTL 1h local), et le sera
par d'autres apps SaaS du polyrepo dans le futur. Plus on a d'apps,
plus le manque de cache edge coûte.

## Reco fix

### Option A — Exclure l'endpoint du middleware Auth.js (recommandé)

`middleware.ts` (ou `auth.config.ts`) :

```typescript
export const config = {
  matcher: [
    /*
     * Match toutes les routes SAUF :
     * - api/pricing/plans (PUBLIC, doit être cachable edge)
     * - api/health      (PUBLIC, healthcheck Docker)
     * - api/webhooks    (PUBLIC machine-to-machine, déjà HMAC-signé)
     * - _next/static    (assets statiques)
     * - _next/image     (image optimisation)
     * - favicon.ico
     * - robots.txt, sitemap.xml
     */
    '/((?!api/pricing/plans|api/health|api/webhooks|api/auth|_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)',
  ],
};
```

**Attention** : si le middleware fait autre chose que Auth.js (rate-limit,
logging…), vérifier l'impact avant exclusion. Au 2026-05-21 le middleware
Hub fait juste `NextAuth().middleware` (auth.config.ts).

### Option B — Strip les Set-Cookie depuis la route handler

Si on ne peut pas modifier le middleware (ex: il sert à autre chose pour
les autres `/api/*`), on peut **strip les Set-Cookie en sortie** du
handler `/api/pricing/plans` :

```typescript
export async function GET() {
  const response = Response.json({...}, {
    headers: {
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
  // Strip set-cookie pour permettre le cache edge
  response.headers.delete('set-cookie');
  return response;
}
```

**Note** : ne fonctionne pas si le middleware ajoute le cookie APRÈS le
handler. Tester avec `curl -I` pour confirmer.

**Reco** : Option A est plus propre architecturalement.

## Gain attendu

- Première hit edge (cache miss) : ~200ms inchangé
- Hits suivants (cache HIT edge) : **~20ms au lieu de 200ms** (10× plus
  rapide)
- Coût CPU container Hub : -1 process par hit caché en edge → libère de
  la capacité pour les routes user-facing
- À 1000 hits/jour de Notifuse + futurs consommateurs : ~3 minutes de
  CPU container libéré par jour

## Tests à ajouter

- Vérifier en staging que `curl -I https://hub.staging.veridian.site/api/pricing/plans`
  ne retourne PAS `set-cookie`
- Vérifier 2 hits successifs : le 2e doit avoir `cf-cache-status: HIT`
  (header Cloudflare) ou équivalent Traefik
- Vérifier que les autres endpoints `/api/auth/*` continuent à recevoir
  les cookies Auth.js correctement
- Vérifier que `/login`, `/dashboard` etc continuent à fonctionner avec
  session cookie

## Risque

🟡 Moyen — toucher au middleware matcher peut affecter d'autres routes.
Tester en staging d'abord, vérifier que :
- `/api/auth/*` fonctionne toujours (callback, signin, session)
- Le rate-limiter sur `/api/auth/[...nextauth]` n'est pas impacté
- `/dashboard` reste protégé (auth required)
- `/api/admin/*` reste authentifié

## Marker commit

`[risk:medium]` — touche au middleware Auth.js. Reco écrite + smoke
staging + check headers manuels avant promotion.
