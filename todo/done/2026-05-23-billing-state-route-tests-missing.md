# [HUB] CI bloquée : 2 tests manquants côté billing (mode Nuclear)

> **Sévérité** : 🟡 P1 (CI Hub CI/CD rouge sur staging depuis 2026-05-23 ~18:45)
> **Owner** : agent Hub billing (qui a livré GET /api/tenants/{id}/billing-state)
> **Créé** : 2026-05-23 — par agent discovery (déposé en file d'attente cross-agent)

## Contexte

Le commit `49b18e8 feat(billing): GET /api/tenants/{id}/billing-state — POLL
reconciliation §6.3 [risk:medium]` a livré :

- `app/api/tenants/[tenantId]/billing-state/route.ts`
- `lib/billing/billing-state.ts`
- `lib/billing/billing-state-hmac.ts`
- `__tests__/lib/billing/billing-state.test.ts`
- `__tests__/api/tenants/billing-state.test.ts` (chemin non canonique)

Le scanner `check-test-mapping.sh` (mode Nuclear) refuse depuis cette
livraison :

```
✗ app/api/tenants/[tenantId]/billing-state/route.ts modifié sans test correspondant
  Test attendu (canonique) : __tests__/api/tenants/[tenantId]/billing-state.test.ts
✗ lib/billing/billing-state-hmac.ts modifié sans test correspondant
  Test attendu (canonique) : __tests__/lib/billing/billing-state-hmac.test.ts
```

**Impact** : tout push staging suivant est aussi rouge sur `Hub CI/CD`
(faux positif pour les autres agents — le job `Hub Staging (dev server)`
reste vert lui, le deploy effectif passe).

## À faire (côté agent billing)

1. **Renommer** `__tests__/api/tenants/billing-state.test.ts` →
   `__tests__/api/tenants/[tenantId]/billing-state.test.ts` (convention
   colocalisée stricte, le scanner ne tolère pas le raccourci sans le
   `[tenantId]` dans le path).
2. **Créer** `__tests__/lib/billing/billing-state-hmac.test.ts` avec
   ≥ 1 test par export public de `lib/billing/billing-state-hmac.ts`
   (probable pattern : signature, verify HMAC, drift, missing headers
   — calquer `lib/discovery/hmac.test.ts` ou `lib/invitations/hmac.test.ts`).

## Pourquoi je ne le fix pas moi-même

Convention `CLAUDE.md` racine §"Flow standard : un agent par app" : je ne
touche pas au code/tests d'un scope qui n'est pas le mien. Je dépose donc
le ticket et préviens.

## Note bonus

J'ai dû ajouter un test pour `billingStatePollLimiter` dans
`__tests__/lib/auth/rate-limit.test.ts` (mon scope `lib/auth/rate-limit.ts`
le touche aussi pour mes `discoveryPreVerifyLimiter` /
`discoveryAppLimiter`). Le test couvre cap=60/min et l'isolation par
clé d'app. Si l'agent billing veut renforcer (cas drift, key composite,
etc.), libre à lui d'ajouter.
