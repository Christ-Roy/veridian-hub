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

## ⏳ Restent à fixer (créer tickets dédiés)

### MEDIUM — Headers de sécurité HTTP manquants

Pas de HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
sur les responses Traefik. Ticket déposé dans `veridian-infra/todo/2026-05-20-traefik-security-headers.md`.

### MEDIUM — Brute-force password limité à 30/min/IP

Les routes `/api/auth/callback/credentials` sont rate-limitées à 30/min/IP
via le wrapper Auth.js livré aujourd'hui. Mais 30 tentatives/min = 43k/jour/IP,
ce qui reste exploitable contre des passwords faibles.

**Fix proposé** : rate-limit séparé par couple (IP, email_target). 5
tentatives/15min/email serait standard industriel (banking).

**Effort** : 1-2h. Tier 🟡 MOYEN, autonome Hub.

### LOW — Pas d'index sur `audit_log.actor`

Pour les requêtes forensics "qui a fait quoi", on a besoin d'index sur
`actor`. Pas urgent (volume faible), à ajouter si volume > 100k rows.

**Fix proposé** : migration Prisma `CREATE INDEX CONCURRENTLY audit_log_actor_idx ON audit_log(actor, created_at DESC)`.

### LOW — Erreur Auth.js details exposés ?

Vérifier que Auth.js v5 ne fuit pas de stack trace en prod (NODE_ENV=production
devrait masquer, mais à valider sur une route qui throw).

### NOT-A-BUG (acceptés)

- 3 CVE moderate transitives (`postcss`, `ws`, `@hono/node-server`) :
  toutes dans dev-deps, non exploitables runtime. Trivy gate prod
  ignore moderate (politique).
- CORS pas configuré : Next.js bloque par défaut les cross-origin POST
  vers /api/, OK.
- ADMIN_SECRET stocké en clair dans Dokploy ENV : standard pour secrets
  ENV, à secret-management migré si jamais SOC2 / etc.
