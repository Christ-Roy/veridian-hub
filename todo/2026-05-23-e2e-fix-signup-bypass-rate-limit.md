# [HUB] E2E fix — étendre bypass rate-limit au signupLimiter + audit headers helpers

> **Sévérité** : 🟡 P1 — bloque 15/16 fails restants E2E full
> **Owner** : sub-agent Opus dédié
> **Créé** : 2026-05-23 par team lead après run 3 E2E (132 passed / 16 failed)

## Contexte

Le commit `c5df1c7` a ajouté `shouldBypassRateLimit()` dans `lib/auth/rate-limit.ts`, appelé par `authenticateAdmin`. Cela couvre `adminApiLimiter` — mais 2 autres limiters frappent encore en cascade :

- `signupLimiter` (utilisé par `/api/auth/signup`) — déclenche les fails spec 06 "signup ... status=429"
- Helpers E2E qui n'incluent pas le header bypass `x-veridian-e2e-bypass-ratelimit` quand ils appellent autre chose que les routes admin

## Mission

### Phase 1 — Étendre bypass à signupLimiter

1. Dans `app/api/auth/signup/route.ts` (ou le handler équivalent) : juste avant `signupLimiter.enforce(ip)`, appeler `shouldBypassRateLimit(request.headers)` et skip si bypass valide
2. Tests Nuclear : `__tests__/api/auth/signup.test.ts` (ou existant) — ajouter cas "bypass header valid + staging → skip rate-limit", "bypass header valid + prod → enforce quand même" (sécu)

### Phase 2 — Audit + fix helpers E2E

3. Grep tous les `e2e/staging-full/_helpers.ts` et fichiers helpers pour les patterns qui font signup/admin/credentials sans inclure le header bypass
4. Centraliser : helper `e2e/staging-full/_helpers.ts` doit exposer `bypassRateLimitHeaders()` qui ajoute toujours `x-veridian-e2e-bypass-ratelimit: process.env.E2E_RATELIMIT_BYPASS_SECRET`
5. Modifier `adminHeaders()`, `signupHeaders()` (à créer si absent) pour inclure `bypassRateLimitHeaders()` par défaut
6. Modifier les specs 05, 06, 11 (et autres si trouvées) pour utiliser le helper

### Phase 3 — Audit autres rate-limits

Dans `lib/auth/rate-limit.ts` lister tous les limiters exportés :
- `adminApiLimiter` ✓ déjà bypass
- `signupLimiter` → à bypass (phase 1)
- `oauthStartLimiter`, `oauthCallbackLimiter` → OAuth est mock en staging, pas de rate-limit critique en E2E
- `credentialsLoginLimiter` → vérifier si E2E impacté (probablement oui)
- `invitationCreateLimiter`, `invitationVerifyLimiter` → idem (spec 05)
- `discoveryPreVerifyLimiter`, `discoveryAppLimiter`, `billingStatePollLimiter` → tester si impacté

Si plusieurs autres limiters sont impactés, étendre `shouldBypassRateLimit()` à tous via un wrapper générique :

```ts
// Idée : RateLimiter.enforce() prend optionnellement les headers, et bypass intégré
const rate = adminApiLimiter.enforceWithBypass(ip, request.headers);
```

## Définition of done

- [ ] `pnpm e2e:staging:full` repasse à >99% (max 1-2 fails attendus = race condition spec 13 S5 traité par autre ticket)
- [ ] Tests Nuclear ajoutés pour bypass signup + autres limiters touchés
- [ ] Helper E2E centralisé, plus de duplication header bypass dans les specs
- [ ] Marker commit `[risk:medium]` (touche auth)
- [ ] DEPLOY_ENV (jamais NODE_ENV)
- [ ] Triple garde-fou anti-fuite prod maintenu

## Contraintes

- Stop sur staging
- Rebase avant push (autre agent actif sur race condition)
- Pas de touche au comportement prod
