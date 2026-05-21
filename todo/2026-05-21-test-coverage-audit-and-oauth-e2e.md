# Audit couverture tests Hub + E2E OAuth manquants

**Créé** : 2026-05-21
**Trigger** : Incident OAuth 2026-05-20→21. Bug `supabaseUserId NULL` sur signups OAuth Google/Microsoft a passé tous les filets (CI verte, audit sécu vert, déploy prod sans alerte) parce que **aucun test E2E ne valide le flow OAuth réel**.

## Contexte de l'incident

- Signup OAuth Google créait des users sans `supabase_user_id` → `userUuid(user)` throw → Dashboard Layout crash en boucle
- 2 users orphelins en prod : `tramtechservices@gmail.com`, `augustindemaret@gmail.com`
- Bug shippé en prod le 2026-05-20 (commit OAuth phase 1), détecté manuellement par Robert le 2026-05-21
- Fix livré le 2026-05-21 (commit `d25f575`) — event `createUser` Auth.js v5 qui patch `supabaseUserId`
- Couverture du fix : **test unitaire 6 cas** seulement, **0 test E2E** du flow OAuth bout-en-bout

## Pourquoi les filets ont laissé passer

| Filet | Statut | Pourquoi ça a raté |
|---|---|---|
| Tests unitaires `sign-in-callback.test.ts` | Vert | Mocke Prisma — ne valide pas que le PrismaAdapter remplit bien `supabaseUserId`. Le bug est dans **ce que le PrismaAdapter NE met pas**, pas dans le callback |
| E2E staging `02-oauth-providers-clickable.spec.ts` | Vert | Vérifie que les boutons OAuth sont **ABSENTS** (invariant Tailscale). N'exécute jamais un flow OAuth |
| E2E staging `03-signup-credentials-flow.spec.ts` | Vert | Teste signup **Credentials**, pas OAuth. Ne vérifie pas non plus que `supabaseUserId` est posé |
| Smoke prod `auth-prod.spec.ts` | Vert | Read-only sur endpoints publics (`/api/auth/providers`, `/csrf`, `/session`). Aucun flow réel |
| Audit sécu `reference_hub_security_audit_2026-05-20.md` | Vert | Couvrait XSS / SSRF / brute-force — pas la cohérence des données utilisateur |

## Travail à faire

### P0 — Filet OAuth (la cause directe de l'incident)

**Objectif** : qu'un futur bug du même type **soit catché par la CI avant deploy prod**.

1. **Mock OAuth provider Auth.js** (`lib/auth/__test__/mock-oauth-provider.ts`)
   - Provider Auth.js v5 custom activé uniquement quand `OAUTH_TEST_PROVIDER=true` ET `NODE_ENV=test`
   - Garde-fou : check au boot qui throw si `NODE_ENV=production && OAUTH_TEST_PROVIDER=true` (backdoor critique sinon)
   - Renvoie un user OAuth mocké (configurable via header HTTP de test)
   - Ne fait AUCUN appel réseau vers Google/Microsoft

2. **E2E staging — Suite OAuth complète** (`e2e/staging-full/04-oauth-flows.spec.ts`)
   - Scénario A — signup Google neuf → vérifie en DB : `supabaseUserId` posé (UUID v4 valide), `Account.provider="google"`, dashboard `/` renvoie 200
   - Scénario B — signup Microsoft neuf → idem avec `provider="microsoft-entra-id"`
   - Scénario C — user Credentials existant clique "Continuer avec Google" → link auto (`allowDangerousEmailAccountLinking`), dashboard OK, 1 user, 2 accounts
   - Scénario D — user Credentials existant clique "Continuer avec Microsoft" → idem
   - Scénario E — re-login Google idempotent (déjà linké) → pas de duplication, session OK
   - Scénario F — cross-provider (Google linké → tente Microsoft, même email) → 2e account ajouté, pas de duplication user
   - Scénario MFA — user `mfaEnabled=true` clique Google → redirect `/auth/mfa`, code email mocké, saisie → dashboard

3. **Câblage CI**
   - Ajouter dans `e2e:staging:full` (déjà gate tier 🔴+ §20)
   - ENV `OAUTH_TEST_PROVIDER=true` injectée uniquement dans le compose staging
   - Vérifier en CI que la variable n'apparaît PAS dans le compose prod (test invariant)

4. **Cleanup tests existants**
   - Renommer `02-oauth-providers-clickable.spec.ts` → `02-oauth-providers-absent-on-staging.spec.ts` (le nom actuel ment sur l'intention)
   - Ajouter assertion DB dans `03-signup-credentials-flow.spec.ts` pour vérifier `supabaseUserId` posé après signup Credentials

### P1 — Smoke OAuth manuel (post-deploy)

**Pourquoi** : le mock saute Google/Microsoft. Ne valide PAS le redirect URI déclaré côté provider, ni les scopes, ni le client secret, ni le Consent Screen.

1. Script `pnpm oauth:smoke:manual` qui :
   - Ouvre `app.veridian.site/login` dans Chrome local
   - Affiche un prompt "clique Google avec un compte test, puis tape 'ok'"
   - Vérifie le dashboard charge, fait un `DELETE` du user créé pour cleanup
   - Idem pour Microsoft
   - Durée totale : ~3 min wall-clock

2. Cron prod mensuel `oauth-health-check`
   - Vérifier expiration secret Microsoft (alerte Telegram si < 90j) — actuellement expire 2028-05-20
   - Vérifier que le discovery doc Google répond (`/.well-known/openid-configuration`)
   - Vérifier statut Consent Screen Google (mode Production attendu après publication ; scraping headless si pas d'API)

### P2 — Audit des autres features sous-testées

Suspects à auditer (test unitaire OK, E2E end-to-end suspect ou absent) :

1. **Provisioning cross-app** — flow `signup → tenant Notifuse créé → magic link envoyé → tenant Prospection créé`. Aucun E2E aujourd'hui qui valide la chaîne complète.
2. **MFA email** — tests unitaires probables, mais E2E avec mock SMTP + saisie code → à vérifier.
3. **Stripe webhooks** — critique billing. Audit needed sur la couverture E2E des 7+ event types (`customer.subscription.created/updated/deleted`, `invoice.paid`, etc.).
4. **Invitations cross-app** (livré 2026-05-21) — endpoint HMAC `POST /api/invitations/create` a des tests unitaires (cf. memory `reference_hub_invitation_hmac_contract.md`), mais E2E end-to-end (Hub → app downstream → user créé → magic link) probablement absent.
5. **Admin API** (livré 2026-05-20) — 4 endpoints. Tests unitaires OK. Pas de scénario E2E "admin créé user via API → user réellement utilisable côté login".
6. **Rate limiting** — tests unitaires sur la lib (`rate-limit.test.ts`). Aucune validation E2E "100 req → 429".

Pour chacun : 1h d'audit + ticket dédié si trou critique.

## Pré-requis avant de commencer

- **Décider du flag** : `OAUTH_TEST_PROVIDER` est-il OK ou faut-il un autre nom moins explicite (genre `AUTH_TEST_BYPASS`) ?
- **Décider du scope** : on fait P0 + P1 + P2 en une seule itération ou on phase ? Reco : P0 d'abord (1-2h), puis P2 audit (3-4h), puis P1 (1h) plus tard.
- **Vérifier que le mock provider ne casse pas la prod** : test invariant CI qui grep le compose prod pour `OAUTH_TEST_PROVIDER` et fail si trouvé.

## Risques / pièges anticipés

- **Backdoor sécu** : un mock provider mal isolé devient une auth bypass en prod. **Garde-fou triple obligatoire** : flag ENV + check `NODE_ENV` + assert au boot Next.js.
- **PrismaAdapter cache** : le PrismaAdapter Auth.js v5 peut cacher les user lookups. Vérifier que les tests démarrent avec une DB propre (transaction rollback ou truncate before each).
- **Tailscale CI** : staging est Tailscale-only, le runner GitHub Actions doit avoir un sidecar Tailscale (déjà câblé pour les E2E actuels, mais à vérifier pour les nouveaux tests qui touchent à l'auth).
- **Dépendance MFA** : le scénario MFA suppose un mock du sender mail. Réutiliser le mock existant si présent dans `__tests__/lib/mfa/`.

## Définition of Done

- [ ] 7 scénarios OAuth E2E passent en CI sur staging
- [ ] Garde-fou triple sur `OAUTH_TEST_PROVIDER` (3 tests d'invariant)
- [ ] Test E2E pour le bug d'hier (`signup Google → supabaseUserId posé → dashboard 200`) — explicite, pas implicite
- [ ] Script `pnpm oauth:smoke:manual` documenté dans `runbooks/services/hub/`
- [ ] Memory `reference_oauth_test_strategy.md` créée
- [ ] Ticket P2 audit features sous-testées créé (un par feature suspecte)
