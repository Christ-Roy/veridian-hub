# Reco écrite §20 — promotion staging → main : events tunnel (signup + app_started)

> **Tier de risque** : 🔴 HAUT (touche `app/api/auth/signup/route.ts` = zone auth)
> **Owner** : agent hub
> **Créé** : 2026-06-11
> **SHA staging** : `9209c3c` (= `1afb98f` code analytics + merge `36cba86` noindex prod)

## 1. Ce qui change

Greffe **additive** best-effort : le Hub émet 2 goals server-to-server vers
Veridian Analytics (workspace `vrd_veridian_site_{prod,staging}` selon
`DEPLOY_ENV`) pour le tunnel de vente.

- `lib/analytics/track-event.ts` (helper fire-and-forget, timeout 2.5s,
  catch-all, zéro retry, env-switch workspace + URL engine).
- `signup` {provider} : `signup/route.ts` (Credentials) + `create-user-event.ts` (OAuth).
- `app_started` {app} : `tenants/start/route.ts`, 1ère provision réelle uniquement.
- fix GA4 : `SignupForm.tsx` pose `?event=signup`.

**Le flow métier signup/provision ne bouge PAS** : tout est en `void`
fire-and-forget. Un échec analytics ne peut PAS casser un signup ou une
provision (pattern void des accroches existantes, prouvé par tests).

## 2. Pourquoi c'est SAFE malgré le tier 🔴

- **Best-effort strict** : 3 tests unitaires dédiés prouvent qu'un échec
  réseau / non-2xx / email vide résout sans throw (`track-event.test.ts`).
  Le call site fait `void trackGoal(...)` sans await → le handler signup
  n'attend jamais l'analytics et n'observe jamais son erreur.
- **Aucune modif du contrat auth** : pas de changement de schéma, de session,
  de validation, de rate-limit. Le seul ajout dans `signup/route.ts` est une
  ligne `void trackGoal(...)` après le `return 201` logique.
- **Surface API inchangée** : mêmes réponses HTTP, mêmes codes, mêmes corps.

## 3. Validation exécutée

- ✅ `tsc --noEmit` exit 0.
- ✅ Suite unitaire complète **2333/2333 verte** (200 fichiers), dont les
  nouveaux tests helper (14) + create-user-event goal (5) + signup goal +
  app_started (replay/échec/déjà-provisionné).
- ✅ CI staging verte (deploy + smoke). CI/CD : test + Trivy + CVE audit verts.
- ✅ **Validation RÉELLE ClickHouse staging** (workspace `vrd_veridian_site_staging`)
  via compte test `test-tunnel-hub@veridian.site` :
  - `signup` / `{provider: credentials}` / `session_id=hub-<uuid>` / `user_id=email` ✓
  - `app_started` / `{app: notifuse}` / même session ✓ (1ère provision réelle)
  - **idempotence** : replay `/api/tenants/start` → `already_provisioned`,
    AUCUN doublon `app_started` en base ✓
- ✅ E2E lourd `playwright.staging-full.config.ts` (395 specs) — voir §5.
- ✅ ZÉRO mail parti (signup + login + provision = aucun envoi ; `e2e.veridian.site`
  sans MX). Compte test nettoyé (user Hub supprimé, workspace Notifuse soft-deleted).

## 4. Piège ff-merge neutralisé

`origin/main` portait `36cba86 fix(seo): noindex hub app` absent de staging.
Un `--ff-only` staging→main aurait été impossible (perte du noindex prod).
→ `origin/main` mergé dans staging (`9209c3c`), main redevenu ancêtre,
ff-merge désormais propre. Vérifié `git merge-base --is-ancestor origin/main HEAD` OK.

## 5. Verdict E2E lourd

(à compléter au verdict du run2 complet)

## 6. Reco

Promouvoir `9209c3c` staging → main (ff-merge), puis monitoring 10 min post-deploy
prod (smoke `/api/health` + watch CI prod + spot-check qu'un signup prod émet
bien le goal vers `vrd_veridian_site_prod`).
