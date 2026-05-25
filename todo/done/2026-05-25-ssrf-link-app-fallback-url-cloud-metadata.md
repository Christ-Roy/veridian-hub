# SSRF — `POST /api/admin/tenants/link-app` `fallback_url` accepte les IPs cloud metadata

> **Sévérité** : 🔴 P0 (faille SSRF — exposition AWS/GCP metadata service)
> **Owner** : agent sécu (hors scope auth/session)
> **Créé** : 2026-05-25
> **Origine** : MEGA E2E spec `e2e/staging-full/mega/I-security/I-03-ssrf-external-urls.spec.ts:113`

## Symptôme

La spec MEGA I-03 envoie `fallback_url: "http://169.254.169.254/"` (AWS EC2 metadata endpoint, classique SSRF cloud) — le Hub répond **200** alors qu'on attend **400/422** (rejet Zod refine).

```
Error: SSRF/scheme attack "http://169.254.169.254/" doit être rejeté, got 200

expect(received).not.toBe(expected)
Expected: not 200
```

## Cause probable

La route `POST /api/admin/tenants/link-app` valide `fallback_url` via `z.string().url()`. `z.url()` accepte toute URL bien formée — **donc `http://169.254.169.254/` passe la validation** car syntaxiquement valide.

Il manque un `.refine()` qui rejette :
- IPs RFC1918 / lien-local (169.254.0.0/16 — cloud metadata AWS/GCP/Azure)
- Loopback (127.0.0.0/8, ::1)
- IPv6 loopback / link-local
- Schemes non-http(s) (file:, javascript:, data:, gopher:, ftp:)
- Hostnames qui résolvent vers du réseau interne Docker (`*-staging-db`, etc.)

## Impact

Si le Hub fait un `fetch(fallback_url)` quelque part (par exemple dans un job background, webhook, ou si le `fallback_url` est rendu dans une page server-side avec preview), un attaquant ayant l'admin secret pourrait :
- Exfiltrer les credentials EC2 IAM via `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
- Scanner le réseau interne Docker staging
- Pivot vers les DB internes

**Note** : la route nécessite l'admin secret, donc le risque pratique est limité — mais l'admin secret peut fuiter (logs, audit ENV exposé) et le principe defense-in-depth exige de fermer cette surface.

## Fix proposé

Dans la route `app/api/admin/tenants/link-app/route.ts`, durcir le Zod schema :

```ts
const SAFE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/;
const BLOCKED_HOSTS_RE =
  /^(localhost|127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc|fd|fe80)/i;

fallback_url: z
  .string()
  .url()
  .refine((u) => SAFE_URL_RE.test(u), 'fallback_url: only http(s) URLs allowed')
  .refine((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return !BLOCKED_HOSTS_RE.test(host);
    } catch {
      return false;
    }
  }, 'fallback_url: host not allowed (private/loopback/metadata)')
  .optional(),
```

Tester via la spec MEGA I-03 qui couvre 17 payloads SSRF classiques.

## Cross-app

Le même pattern existe probablement sur `POST /api/billing/refill-leads/checkout-from-app` (`success_url`, `cancel_url`). Audit à faire — la spec I-03 a une sous-section qui le couvre via fail HMAC qui masque le problème.

## À ne PAS faire

- Ne pas blacklister par regex sur le `fallback_url` brut (un attaquant peut bypass avec URL-encoding, IPv6 longhand, octets décimaux IP type `http://2852039166/`). La résolution doit passer par `new URL().hostname` puis check hostname normalisé.

## Périmètre voisin (ne pas confondre)

L'agent fix-auth-session a ajouté `bypassRateLimitHeaders()` côté spec I-03 pour stabiliser le setup user create (cumul rate-limit en mega-full run). Le vrai bug SSRF reste ouvert et nécessite ce ticket.
