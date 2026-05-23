# [HUB] E2E fix — cascade rate-limit /api/admin/users/create (53 fails sur 5 specs)

> **Sévérité** : 🔴 P0 — bloque promo main (5 specs cascadent)
> **Owner** : sub-agent Opus dédié
> **Créé** : 2026-05-23 par team lead après 2e run `pnpm e2e:staging:full`

## Symptôme

53 fails sur 148 specs au 2e run. Pattern dominant dans les messages d'erreur :

```
Error: [e2e setup "s6-create-user"] expected status in [200], got 429.
Error: admin create e2e-legacy-no-uuid-inviter-... got 429
Error: path traversal email param doit être rejeté proprement (got 429)
```

5 specs cascadent toutes pour la même raison :

| Spec | Fails | Cause |
|---|---|---|
| 13-admin-api-security | 34 | setup admin user crée = 429 |
| 05-invitation-cross-app-flow | 22 | setup inviter user = 429 |
| 15-legacy-tenants-paths | 16 | "admin create e2e-legacy-..." = 429 |
| 07-admin-api-roundtrip | 14 | setup admin = 429 |
| 11-invite-page-ux-flow | 10 | setup inviter user = 429 |

## Cause racine probable

Le helper `e2e/staging-full/_helpers.ts` fait DÉJÀ la rotation IP via `x-forwarded-for: 10.99.x.x` (auto-incrémenté à chaque call) pour bypasser `adminApiLimiter` (30/min/IP, défini dans `lib/auth/rate-limit.ts:132`).

**Mais `lib/auth/rate-limit.ts:extractClientIp()` ne trust peut-être pas le header X-Forwarded-For derrière Traefik staging.**

Si `extractClientIp()` retourne la vraie IP socket (= IP Traefik unique), toutes les requêtes E2E partagent le même bucket rate-limit (30/min) → cap atteint au bout de 30 admin creates → tous les setups suivants 429.

## Plan d'investigation

### Phase 1 — Audit `extractClientIp()` (15 min)

1. Lire `lib/auth/rate-limit.ts:extractClientIp()` — comment il extrait l'IP ?
2. Vérifier l'ordre de priorité :
   - Header `x-forwarded-for` ?
   - Header `x-real-ip` ?
   - Socket IP (`request.ip` ou fallback) ?
3. Vérifier si Traefik staging passe bien `X-Forwarded-For` au container hub-staging (devrait, c'est default Traefik)
4. Tester en réel : faire 35 requêtes E2E rapide avec rotation IP, vérifier qu'aucune ne tombe en 429

### Phase 2 — Fix (selon trouvaille)

**Option A** — Si `extractClientIp()` ne trust pas `x-forwarded-for` :
- Trust le header derrière Traefik (avec validation : seul le proxy upstream peut poser ce header — vérifier si nécessaire, mais Traefik fait ça)

**Option B** — Si trust mais cap quand même atteint :
- Augmenter `adminApiLimiter.capacity` à 100 ou 500 en staging via ENV (`ADMIN_API_LIMITER_CAPACITY=100` lu si `DEPLOY_ENV=staging`)

**Option C** — Bypass staging-only via header secret :
- Ajouter dans `extractClientIp()` ou en pre-flight : si header `x-veridian-e2e-bypass-ratelimit: <SECRET_STAGING>` présent ET `DEPLOY_ENV !== 'prod'` → skip rate-limit
- Helper E2E pose ce header automatiquement (secret depuis `E2E_RATELIMIT_BYPASS_SECRET` dans `/opt/staging/hub/.env`)

**Option D** — Reset programmatic du limiter entre specs :
- Exposer une route admin (staging-only) `POST /api/admin/_internal/reset-rate-limit` qui appelle `adminApiLimiter.reset()` — appelée en `beforeAll` de chaque spec

**Reco** : Option C (bypass header secret). Pas de touche au comportement prod, défense en profondeur via secret long, isolation totale entre tests, pas besoin d'augmenter les seuils prod-like.

### Phase 3 — Bonus : 2 specs path traversal hors cascade

Spec 16 S3 et spec 13 S10 testent que `/api/invitations/../admin/users/create` renvoie 404. Probablement Next.js retourne 308 (redirect normalize) ou 500. À vérifier après le fix rate-limit (peut-être que ces specs passent une fois le rate-limit fixé).

## Définition of done

- [ ] Fix livré (Option A, B, C ou D selon investigation)
- [ ] `pnpm e2e:staging:full` repasse à 100% (ou ≥95% avec flakes connus documentés)
- [ ] Tests Nuclear si modif `lib/auth/rate-limit.ts` ou `lib/admin/authenticate.ts`
- [ ] Push staging
- [ ] Reco écrite pour promo main

## Contraintes

- Marker commit `[risk:medium]` (touche auth/admin)
- Pas de touche au comportement prod (DEPLOY_ENV !== 'prod')
- DEPLOY_ENV, jamais NODE_ENV
- Pas de bypass complet du rate-limit prod
- Stop sur staging
