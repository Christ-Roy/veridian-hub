# [HUB] Audit sécu 2026-05-20 — Follow-ups non livrés dans la session

> **Type** : Suivi sécu
> **Sévérité** : 🟡 P2 (les fixes HIGH ont été livrés, restent les MEDIUM/LOW)
> **Owner** : agent Hub
> **Créé** : 2026-05-20 (post-audit interne)

## Contexte

Audit sécu interne effectué 2026-05-20 par l'agent Hub après livraison
de l'admin API. **9 issues trouvées**, 6 fixées en prod dans la session,
3 documentées ici pour prochaines sessions.

## ✅ Fixés en prod (commit `f4fd60f` + `50650de`)

1. **HIGH** — XSS via `fallback_url` scheme `javascript:`/`data:`
   → `z.string().url().refine(http/https only)`
2. **MEDIUM** — Slug/tenant_name/notes acceptent `<>`, CRLF, etc.
   → Regex DNS-safe + refine() chars contrôle
3. **HIGH** — Pas de rate-limit sur routes admin
   → `adminApiLimiter` 30/min/IP dans `authenticateAdmin()`
4. **LOW** — Comparaison `x-admin-secret` non timing-safe
   → `crypto.timingSafeEqual` avec padding
5. **MEDIUM** — Race condition anti-lockout DELETE provider
   → `prisma.$transaction` wrapper
6. **HIGH** — Pas de rate-limit sur signup public (15 signups // = 15× 201)
   → `signupLimiter` 5/min/IP

7. **HIGH** — `next.config.js` `remotePatterns: [{hostname:'**'}]` = wildcard
   total. Latente CVE-2024-34351 SSRF + DoS bande passante via /_next/image.
   → Whitelist explicite (lh3.googleusercontent.com, graph.microsoft.com,
   cdn.veridian.site, assets.internal.veridian.site) + contentDisposition
   attachment + CSP sandbox. Smoke prod 400 sur hostnames non-whitelist,
   200 sur vrai avatar Google AVSE.

8. **CLEANUP** — `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` traînaient
   dans ENV Dokploy Hub prod alors que Hub n'utilise plus Supabase depuis
   2026-05-08 (Auth.js v5). Nettoyé via Dokploy API. Pas une vuln directe
   (pas exposé NEXT_PUBLIC), juste du dead weight.

## ⏳ Restent à fixer (créer tickets dédiés)

### ✅ MEDIUM — Headers de sécurité HTTP — FIXÉ 2026-05-20 (veridian-infra commit `7030d94`)

Middleware `veridian-security-headers` câblé en global sur l'entryPoint
websecure de Traefik prod (HSTS 6 mois, frameDeny, contentTypeNosniff,
referrerPolicy strict-origin, Permissions-Policy bloquant camera/mic/geo).
S'applique à toutes les apps prod (Hub, Notifuse, CMS, Prospection,
Analytics, verger-shop, Dokploy).

CSP non livré (trop complexe générique, ticket dédié si besoin).

### ✅ MEDIUM — Brute-force password limité à 30/min/IP — FIXÉ 2026-05-20 (commit `5330dfe`)

Limiter dédié `credentialsLoginLimiter` 5/min/IP appliqué prioritairement
sur `/api/auth/callback/credentials` dans le wrapper Auth.js.

**Reste à faire (P3 si attaques observées)** : rate-limit par couple
(IP, email_target) pour empêcher un botnet de répartir l'attaque sur N
IPs contre un même email. Nécessite de parser le body x-www-form-urlencoded
avant Auth.js. À câbler si attaques observées dans audit_log.

### ✅ LOW — Index `audit_log.actor` — FIXÉ 2026-05-20 (commit `c32badb`)

Migration `20260520180000_add_audit_log_actor_index` appliquée DB staging +
prod. Index `(actor, created_at DESC)`. Endpoint forensics dédié
`GET /api/admin/audit-log?actor=...` qui exerce l'index.

### ✅ LOW — Erreur Auth.js details exposés ? — VÉRIFIÉ NO-LEAK 2026-05-20

Test prod direct :
- `POST /api/auth/callback/credentials` avec creds bidons → 302 propre,
  body vide.
- `GET /api/auth/callback/google?error=bla&error_description=test` →
  302 vers `/login?error=Configuration` → page rend une bannière i18n
  user-friendly ("Le provider de connexion n'est pas correctement configuré.
  L'équipe Veridian a été notifiée. Réessayez plus tard ou utilisez
  email/mot de passe.").

Pas de stack trace, pas de chemin filesystem, pas de digest exposé,
pas de noms de modules internes. Auth.js v5 + Next 15.5.18 + NODE_ENV=production
font le job par défaut. Aucune action requise.

### NOT-A-BUG (acceptés)

- 3 CVE moderate transitives (`postcss`, `ws`, `@hono/node-server`) :
  toutes dans dev-deps, non exploitables runtime. Trivy gate prod
  ignore moderate (politique).
- CORS pas configuré : Next.js bloque par défaut les cross-origin POST
  vers /api/, OK.
- ADMIN_SECRET stocké en clair dans Dokploy ENV : standard pour secrets
  ENV, à secret-management migré si jamais SOC2 / etc.
