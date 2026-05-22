# [HUB] Audit dette technique post-sprint v1.4

> **Type** : Audit + cleanup dette tech
> **Sévérité** : 🟢 P2 (qualité long terme, pas bloquant)
> **Owner** : agent Hub
> **Créé** : 2026-05-21 (post-clôture sprint v1.4)
> **Refs** : memory `project_sprint_v14_complete_2026-05-21`

## Contexte

Sprint v1.4 livré + bugs critiques fixés. Avant d'attaquer le ticket #3 trial state machine ou un nouveau sprint, faire le ménage sur les traînées identifiées pendant cette session + audit large du codebase Hub.

Pas urgent (prod healthy), mais à clore avant que ça se sédimente.

---

## 1. Legacy Supabase à retirer définitivement (P2)

Hub a migré Auth.js v5 le 2026-05-08, et la session 2026-05-13 a retiré les ENV Supabase du compose. **Mais le code applicatif référence encore Supabase à 10+ endroits** :

```
app/dashboard/layout.tsx
app/api/auth/signup/route.ts
app/api/admin/users/create/route.ts
app/api/admin/users/[email]/route.ts
app/api/admin/tenants/unlink-app/route.ts
app/api/admin/tenants/link-app/route.ts
app/api/admin/notifuse/magic-link/route.ts
app/api/admin/delete-tenant/route.ts
app/api/admin/list-tenants/route.ts
lib/auth/get-user.ts
app/(auth)/auth/verify/page.tsx  # page legacy de vérification email Supabase OTP
```

**À faire** :
- Identifier les references **vraiment legacy** (vivant code mort) vs celles qui touchent `supabaseUserId` (qui reste actif comme **UUID v4 bridge cross-app** — ne pas confondre avec Supabase Auth).
- `app/(auth)/auth/verify/page.tsx` : page legacy OTP Supabase — vérifier qu'elle est inutilisée (routes Auth.js v5 gèrent maintenant la vérif via /api/auth/verify-request) puis retirer.
- `app/api/auth/[...nextauth]/route.ts:4` : commentaire dit "coexiste avec les routes Supabase Auth legacy qui vivent ailleurs" — auditer ce qui reste à retirer.
- `.env.example` : supprimer `NEXT_PUBLIC_SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` si jamais lues par le code (l'agent check-env-sync les a déjà flag).

**Garde-fous** :
- Ne JAMAIS renommer `User.supabaseUserId` (c'est l'UUID bridge cross-app, ACTIF, post-2026-05-21).
- Les routes Auth.js v5 doivent rester intactes.
- Faire le retrait **par PR petites** plutôt qu'un gros nettoyage — moins de risque de régression auth.

### Audit 2026-05-22 (Lot C cleanup) — état réel

Audit complet des refs `supabase` dans le code applicatif (`app/`, `lib/`,
`contexts/`, `utils/`) :
- **0 import Supabase** (`@supabase/*`), **0 dépendance** `@supabase` dans
  `package.json`, **0 var ENV** Supabase dans `.env.example` / `.env.dev.example`
  (déjà nettoyées par PR #90 le 2026-05-13).
- Toutes les occurrences restantes sont soit `supabaseUserId` (bridge UUID
  ACTIF — interdit d'y toucher), soit des **commentaires historiques** qui
  expliquent encore correctement le code :
  - `app/(auth)/auth/verify/page.tsx` : commentaire "page legacy OTP" — toujours
    exact, explique pourquoi le stub existe. Conservé.
  - `app/dashboard/layout.tsx:18` : "Pas d'appel Supabase ici" — garde-fou
    correct. Conservé.
- Commentaires Supabase obsolètes repérés mais **hors périmètre Lot C**
  (cosmétiques, à nettoyer quand on touchera ces fichiers) :
  `contexts/EnvContext.tsx:76`, `app/(marketing)/layout.tsx:16`,
  `app/(marketing)/page.tsx:29`.

**Conclusion** : il n'y a plus de dette Supabase fonctionnelle à retirer. Le
code applicatif est propre. Seul reste un toilettage de commentaires cosmétique
(3 fichiers ci-dessus) + l'audit du commentaire `app/api/auth/[...nextauth]/`
mentionné plus haut. La case DoD "0 référence supabase" est de facto atteinte
si on excepte `supabaseUserId` (volontaire) et les commentaires historiques.

---

## 2. Pricing — TODO_PRICE / TODO_STRIPE dans `lib/pricing/plans.ts` (P1)

Le fichier `lib/pricing/plans.ts` a **18 occurrences `🚧 TODO_PRICE`** et `🚧 TODO_STRIPE`. Les prix sont des placeholders + les `stripePriceId` sont `null`. Tant que ces TODO sont là :

- Le code de billing ne peut pas créer de session checkout Stripe pour ces plans (priceId null).
- Le pivot pricing 2026-05-21 figé par Robert (cf `docs/PRICING-VERIDIAN.md`) ne peut pas être appliqué sans synchronisation Stripe Dashboard ↔ `plans.ts`.

**À faire** :
- Valider les prix avec Robert (cf source de vérité `docs/PRICING-VERIDIAN.md`).
- Créer les Products + Prices Stripe correspondants (dashboard ou via Stripe CLI).
- Remplir `stripePriceId` dans `plans.ts`.
- Tests d'intégration : checkout E2E sur chaque plan en mode test (Stripe test cards).

**Lien** : ticket `2026-05-21-trial-state-machine.md` (le trial consomme ces prices via webhook orchestrator central). Pas bloquant pour démarrer trial-state-machine, mais bloquant pour LE PREMIER vrai upgrade payant.

---

## 3. TODO impersonate route (P3) — ✅ RÉSOLU 2026-05-22

`app/api/admin/impersonate/route.ts` avait 3 `TODO LOT D`. **Tous bouclés**,
impersonate fonctionne end-to-end.

### Ce qui a été livré (Backend Lot 2)

**Diagnostic clé** : l'ancien code créait une row `prisma.session` (token
random 32 bytes, TTL 24h). Or la stratégie de session du Hub est `jwt`
(`auth.config.ts:17`) — **Auth.js ne lit JAMAIS la table `sessions` en mode
JWT**. Le cookie attendu est un JWE signé avec `AUTH_SECRET`. L'ancien
"token" n'aurait jamais produit de session valide → impersonate était cassé
par conception, pas juste incomplet.

**Nouveau design** (`lib/auth/impersonation.ts` — helper central) :
- `createImpersonationToken` : token random 32 bytes, **stocké hashé
  (SHA-256)** dans `verification_tokens` avec identifier préfixé
  `impersonate:<userId>`, **TTL 10 min**.
- `consumeImpersonationToken` : **delete atomique** (`deleteMany` → usage
  unique garanti même en course concurrente) + check expiry. Source de
  vérité = l'identifier de la row, pas l'input appelant.
- `encodeImpersonationSessionJwt` : encode un **vrai JWT Auth.js**
  (`encode` de `next-auth/jwt`) avec `salt = nom du cookie` (exigence
  `@auth/core/jwt`). Claims `impersonated:true` + `impersonatedBy`. **TTL
  session 1h** (vs 90j normal — une impersonation est ponctuelle).

**Endpoints créés** :
- `POST /api/auth/impersonate-set` — admin-only (`authenticateAdmin`),
  génère le token + retourne `callback_url`. Audit `admin.impersonate.start`.
- `GET /api/auth/impersonate-callback?token=…` — consomme le token (usage
  unique), pose le cookie de session Auth.js (httpOnly/secure/sameSite=lax),
  redirige `/dashboard`. Audit `admin.impersonate.consume`.

**Garanties sécu** (tier 🔴 HAUT) :
- Seul un platform admin déclenche (`authenticateAdmin` / `isPlatformAdmin`).
- Token court-vécu, usage unique, stocké hashé (un dump de
  `verification_tokens` ne révèle aucun token utilisable).
- **Anti-ré-impersonation** : `isImpersonatedSession()` bloque toute session
  impersonée dans `authenticateAdmin`, `requireAdmin` inline de la route
  impersonate, et `impersonate-set`. Un user impersoné ne peut PAS rebondir.
- Audit log à chaque start + consume.
- `AUTH_SECRET` absent → aucun cookie posé, refus net.

**Tests** : 41 tests dédiés (helper crypto réel + 2 routes + route admin
mise à jour). Suite complète 1063/1063 verte, `pnpm build` OK.

### TODO restant — bannière UI (hors périmètre backend)

Le claim `session.user.impersonated` + `impersonatedBy` est **exposé côté
session** (callbacks `auth.ts`) et typé (`types/next-auth.d.ts`). Reste à
brancher une **bannière visuelle "Mode impersonation"** dans le layout
dashboard — travail UI à confier à l'agent frontend. Le backend est prêt :
il suffit de lire `session.user.impersonated` dans un Server Component.

---

## 4. tests-pending.txt — 58 entrées (P2)

58 fichiers source applicatifs ont une dette de test dans `tests-pending.txt`. Le mode Nuclear actif (configuré 2026-05-17) refuse d'agrandir cette liste, mais ne force pas à la diminuer.

**À faire** : sprint dédié de **rattrapage tests** sur les 58 entrées. Prioriser :
- Routes API (~25 entrées)
- Composants critiques (~15 entrées dashboard/billing/admin)
- Le reste = utilitaires (~18)

Estimation : 1-2j de boulot agent QA dédié si on attaque tout. Sinon, attaquer par paquets de 10 sur des sessions normales.

---

## 5. Dépendances outdated (P2) — ✅ PATCHES SAFE FAITS 2026-05-22

`pnpm outdated` révèle :
- `@stripe/stripe-js` 2.4.0 → 9.6.0 — **bond majeur**. Risque de breaking changes côté checkout/elements. Audit avant upgrade. **LAISSÉ** (hors périmètre patches safe).
- `stripe` (SDK serveur) 14.25.0 → 22.1.1 — **bond majeur** aussi. **LAISSÉ**, à auditer avec @stripe/stripe-js dans le sprint pricing.
- ✅ `@playwright/test` 1.59.1 → 1.60.0 — **bumpé** (commit `5eac119`)
- ✅ `pg` 8.20.0 → 8.21.0 — **bumpé** (commit `5eac119`)
- ✅ `vitest` 4.1.5 → 4.1.7 — **bumpé** (commit `5eac119`)
- `@types/bcryptjs` deprecated — passer à `@types/bcrypt` ou retirer si `bcryptjs` n'est plus utilisé (Auth.js v5 utilise sa propre lib hash). **RESTE** (P3, hors patches safe).
- `@types/node` 20.19 → 25.9 — Node 25 sortie. Notre image Docker est `node:20-alpine`. Pas upgrader avant que Dockerfile passe en node:22 ou 24. **LAISSÉ** (volontaire).

Les 3 patches safe ont été appliqués : `pnpm install` + `pnpm test` (1006 verts) + `pnpm build` verts. Reste l'audit Stripe SDK majeur (×2 paquets) pour le sprint pricing.

---

## 6. Coexistence routes webhook notifuse v1.4 + legacy HMAC (P3)

`app/api/webhooks/notifuse/route.ts` route DEUX formats :
- v1.4 (Bearer) — nouveau
- Legacy HMAC (header `x-veridian-notifuse-signature`) — pour le fork Notifuse en prod qui n'a pas encore migré

État actuel : intermédiaire propre (commentaires bien documentés, routing clair). **Mais** :
- Le code legacy `handleLegacyNotifuseHmac` (lignes ~120-220) ajoute ~100 lignes de complexité.
- L'idempotence legacy stocke les 200 derniers `event_id` dans `tenant.metadata.notifuse_processed_events` — pollution metadata, scaling pas terrible.
- Si Notifuse migre tout en v1.4 (plus de pattern legacy émis), on peut purement supprimer la branche legacy.

**À faire** :
1. Confirmer avec l'agent Notifuse quand toute leur émission passe en v1.4 (events `tenant.suspended`, `email.sent`, `tenant.quota_exceeded` en particulier).
2. Quand confirmé : supprimer `handleLegacyNotifuseHmac` + cleanup metadata `notifuse_processed_events`.
3. Migration data : `UPDATE hub_app.tenants SET metadata = metadata - 'notifuse_processed_events'`.

### Vérif 2026-05-22 (Lot 4 dette) — état confirmé

Code legacy toujours présent dans `app/api/webhooks/notifuse/route.ts` :
`handleLegacyNotifuseHmac` (l.107+), headers `x-veridian-notifuse-signature`,
idempotence via `tenant.metadata.notifuse_processed_events`. **NON SUPPRIMÉ** —
dépend de l'agent Notifuse (étape 1 ci-dessus pas encore validée). Reste ouvert.

---

## 7. Composes Dokploy — vider les composeFile inline (P2)

Cf memory `reference_dokploy_faux_gitops`. Hub prod composeId `_kxAHDCv1LhvsdwNRX3Vk` a un `composeFile` inline historique (4097c) qui est **ignoré au runtime** (Dokploy lit le compose Git du repo). Mais c'est de la pollution UI confuse.

**À faire** :
- Backup composeFile inline (déjà fait : `~/backups/dokploy/hub-prod-20260521-171028.json`)
- `compose.update body={composeFile: ""}` pour vider
- Vérifier que le redeploy continue de fonctionner avec uniquement le compose Git
- Faire idem sur les 4 autres composeIds (Notifuse, CMS, Analytics, Prospection, Supabase legacy) — probable même pattern faux GitOps.

---

## 8. _signin-legacy mentions (P3) — ✅ RÉSOLU 2026-05-22

`app/robots.ts:36` : `/_signin-legacy/` dans le robots.txt. Probablement un path qui n'existe plus depuis Auth.js v5. À retirer si confirmé inutile.

**Fait (Lot C cleanup)** : confirmé inexistant — aucune route `_signin-legacy`
nulle part dans `app/`. Retiré du `disallow`. En passant, `/signin/` et
`/signin1/` aussi retirés du `disallow` (ils sont désormais des redirects 308
`next.config.js`, plus des pages indexables).

---

## 9. Données seed staging à nettoyer (P3)

Sessions E2E successives ont laissé en hub-staging-db :
- 12+ users `user-e2e-*` et `e2e-*@veridian.site`
- Workspaces orphelins + memberships + accounts OAuth
- Cross-app invitations Hub

Script SQL prêt : `/tmp/cleanup-seed-staging.sql` (54 lignes, transactionnel). À jouer après confirmation que ces users ne sont pas nécessaires pour les futurs E2E.

---

## 10. Backfill workspaces : exécuter le script TS au lieu du SQL inline (P3)

L'agent DBA prod a fait le backfill 23 users via SQL direct (CTE en transaction) car pas de tunnel SSH vers la DB. Le script `scripts/admin/backfill-workspaces.ts` est livré mais **jamais exécuté tel quel**.

À faire : tester le script TS sur staging (workspaces vides après cleanup #9) pour confirmer DoD du ticket `2026-05-21-workspace-provisioning-at-signup.md`. Si OK, archiver le ticket dans done/.

---

## 11. Comments obsolètes / commentaires "legacy bridge" (P3) — ✅ TRAITÉ 2026-05-22

`app/api/account/profile/route.ts:11` et `app/dashboard/workspace/members/page.tsx:32` mentionnent "user prod legacy en attente de backfill". Maintenant que le backfill est fait, ces commentaires sont obsolètes. Cleanup pendant qu'on touche.

**Fait (Lot 4 dette, commit `08df40f`)** :
- `members/page.tsx` : commentaire self-heal réécrit — "À court terme : backfill
  23 users prod" supprimé (backfill fait 2026-05-21), filet anti-régression
  décrit comme permanent. Aucune logique modifiée, test page vert (10/10).
- `profile/route.ts:11` : "legacy bridge" décrit `providerAccountId` du
  `supabaseUserId` bridge UUID — **toujours actif**, commentaire exact. Non touché.

---

## 12. Erreurs tsc e2e/staging-full — conflit playwright-core / @playwright/test (P3)

22 erreurs `TS2345` dans `e2e/staging-full/*.spec.ts` (vérifié 2026-05-22,
après bump `@playwright/test` 1.60 — **le bump ne les résout pas**) :

```
error TS2345: Argument of type 'typeof import(".../playwright-core@1.60.0/.../types/types")'
is not assignable to parameter of type 'typeof import(".../@playwright+test@1.60.0/.../@playwright/test/index")'
```

**Cause** : plusieurs helpers (`loginCredentials`, etc.) typent leur param
`playwright: typeof import('@playwright/test')`, mais la fixture `playwright`
injectée par `@playwright/test` est typée `playwright-core` (deux modules
distincts, types non assignables). Fichiers touchés : `05`, `06`, `11-invite-page-ux`,
`11-ui-invite`, `12-stripe-billing`, `15-legacy-tenants-paths`.

**Impact réel : nul** sur build (`next build` exclut e2e) et sur vitest
(e2e ≠ vitest). Uniquement du bruit `tsc --noEmit` strict.

**Fix recommandé** (hors périmètre dette code, ticket dédié) : retyper le
param helper en `Pick<PlaywrightWorkerArgs, 'playwright'>['playwright']` ou
utiliser directement la fixture Playwright typée plutôt qu'un import manuel.

---

## Plan d'attaque suggéré

1. **Quick wins** (1-2h) : #8 + #11 + #9 (cleanup seed) — pas de risque, hygiène.
2. **P1** (3-4h) : #2 pricing TODO_STRIPE — bloquant pour les premiers upgrades payants
3. **P2 long terme** : #1 cleanup Supabase legacy par PR petites (~5h cumulées), #4 rattrapage tests-pending (1-2j), #5 deps patches safe, #7 cleanup Dokploy inline
4. **À coordonner cross-app** : #6 retirer legacy HMAC notifuse (dépend de l'agent Notifuse)

## DoD

- [ ] 0 référence `supabase` dans le code applicatif (sauf `supabaseUserId` bridge volontaire)
- [ ] 0 `🚧 TODO_*` dans `lib/pricing/plans.ts` (prices remplis + stripePriceId set)
- [ ] tests-pending.txt < 30 entrées
- [x] Dépendances safe patchées (pg, vitest, playwright — 2026-05-22 commit `5eac119`)
- [ ] Audit majeur Stripe SDK fait + plan upgrade documenté
- [ ] Composes Dokploy : composeFile inline vidé pour les 5 stacks
- [ ] Données seed staging nettoyées
