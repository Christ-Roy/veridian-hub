# OAuth — Couverture des 13 scénarios cross-app Veridian

> **Type** : Ticket de suivi exhaustif, post-livraison OAuth Phase 1
> **Owner** : agent Hub
> **Sévérité** : 🟡 P2 (suivi continu — pas urgent mais à clore avant scale)
> **Créé** : 2026-05-20 après validation manuelle prod par Robert
>
> **Contexte** : OAuth Google + Microsoft Sign-in livrés en prod le 2026-05-20
> avec `allowDangerousEmailAccountLinking` activé sur les 2 providers. Tous
> les scénarios "happy path" marchent. Ce ticket liste les cas d'usage non
> couverts ou non testés, à traiter par ordre de priorité.

## Matrice complète des scénarios

### ✅ Validés (Phase 1 livrée — Sign-in fonctionne)

- [x] **A. Nouvel user signup direct via Google** (compte Veridian inexistant)
      → Auth.js crée user + account Google, redirect dashboard
- [x] **B. Nouvel user signup direct via Microsoft** (idem A)
- [x] **C. User existant Credentials/magic → login Google même email**
      → Auto-link grâce à `allowDangerousEmailAccountLinking`
      → Validé manuellement par Robert avec brunon5robert@gmail.com (2026-05-20)
- [x] **D. User existant → login Microsoft même email**
      → Idem C
      → Validé manuellement par Robert avec robert.brunon@veridian.site (2026-05-20)
- [x] **E. User Google déjà linké → re-login Google**
      → Auth.js retrouve account par (provider, providerAccountId), trivial

### 🟡 Tier MOYEN — à traiter dans la semaine

- [x] **F. User Google linké → tente login Microsoft (même email)** ✅ 2026-05-22
      Comportement Auth.js confirmé : link en plus dans `hub_app.accounts`
      (2 rows même `userId`, providers différents) via le PrismaAdapter +
      `allowDangerousEmailAccountLinking`. Le callback `signIn` retrouve le
      user par email et autorise sans bloquer le link.
      Tests câblés : `__tests__/api/auth/dual-provider.test.ts` (scénario F :
      autorise, MFA non bypassée, re-login idempotent).
      Reste UI (boutons "Connected" dans Settings → Account) : déjà couvert
      par le ticket account-settings-connected-providers (livré 2026-05-20).

- [x] **I. Email primaire Google ≠ Microsoft (rare, possible avec alias)** ✅ 2026-05-22
      Comportement confirmé et **documenté comme accepté** : Auth.js v5 crée
      **2 users distincts** (pas de merge heuristique). Décision : pas de flow
      "Merge accounts" pour l'instant — les 2 identités restent indépendantes
      (MFA propre à chacune, pas de fuite croisée).
      Tests câblés : `__tests__/api/auth/dual-provider.test.ts` (scénario I :
      2 users distincts, identités indépendantes, MFA non contaminée).

- [ ] **J. User révoque Google côté myaccount.google.com**
      Symptôme : refresh token invalidé silencieusement. Le user reste loggué
      via cookie session Hub (90j) jusqu'à expiration. Au prochain login
      Google → demande re-consent. Pas critique mais surprend les users.
      → ajouter un endpoint `POST /api/auth/oauth/revoke-stale` qui ping
      Google/MS pour vérifier que le refresh token est encore valide.

- [ ] **M. OAuth réussi mais aucun workspace provisionné Notifuse/Prospection/Analytics**
      Le user atterrit sur dashboard "Apps disponibles" vide. UX à designer :
      - Welcome screen first-time avec CTA "Activate Notifuse"
      - Onboarding wizard 3 étapes (signup → activate first app → invite team)
      Cf. ticket onboarding séparé.

### 🟢 Tier BAS — quand on aura traction (>100 users actifs)

- [ ] **K. User supprime son compte Veridian, retente Google plus tard**
      Si soft-delete : conflit `email UNIQUE` sur `hub_app.users` → reject.
      Si hard-delete (cascade `accounts`/`sessions`) : OK Auth.js recrée.
      → Décider la politique de suppression (soft vs hard) avec impact RGPD.

- [ ] **L. Bouton OAuth cliqué hors session, callback expire (>15 min)**
      Auth.js renvoie `?error=Verification` ou similaire. UX à polir :
      page custom `/login?error=*` avec message clair par type d'erreur
      + CTA "Recommencer".

### 🔴 Scénarios CROSS-APP — sévérité variable

- [ ] **G. User invité à un workspace Prospection (existe pas encore Hub)**
      Voir ticket séparé : `todo/integrations/2026-05-20-prospection-invite-flow.md`
      Statut actuel : **flow magic link Prospection court-circuite le Hub**.
      Si l'invité tente ensuite "Continuer avec Google" sur app.veridian.site,
      Auth.js crée un user Hub orphelin sans lien avec son workspace
      Prospection. **Le user a 2 identités distinctes pour Veridian.**

- [ ] **H. User accepte invitation Prospection puis tente login Google sur Hub**
      Cas concret de G. Conséquence visible :
      - User loggué Google sur Hub voit "Aucune app activée"
      - Mais en parallèle reçoit emails Prospection
      - Stripe customer Hub crée séparé du user_id Prospection
      → corruption identité long terme.
      Fix : refactor flow invitation Prospection pour passer par Hub
      (le Hub crée user + workspace côté Prospection via le contrat HMAC §3
      du CONTRAT-HUB.md).

## Tests à câbler (par ordre de ROI)

| Test | Scope | Effort | ROI |
|---|---|---|---|
| Tests unitaires Auth.js callbacks `signIn`/`jwt`/`session` | Scénarios C/D/F/I | 2-3h | Très haut (préviens régression silencieuse) |
| Test intégration DB éphémère scénarios A-F | Vraie DB Postgres | 3-4h | Haut (catch les race conditions) |
| E2E Playwright `oauth-real-account.spec.ts` | A-F avec compte test Google `oauth-tester@veridian.site` | 4-6h | Moyen (anti-bot Google flake) |
| Test régression UX `?error=*` | L, M | 1-2h | Bas (peu d'users impactés) |
| Test cross-app G/H | Hub ↔ Prospection invite flow | 6-8h | **Critique** (corruption identité) |

## Prochaine action

1. **Aujourd'hui** : valider scénario F manuellement (toi → loggue avec Microsoft sur un compte qui s'est précédemment loggué avec Google, vérifier que ça merge bien dans `accounts`)
2. **Cette semaine** : ouvrir le ticket G/H avec l'agent Prospection (cf. fichier séparé)
3. **Sprint suivant** : câbler les tests unitaires Auth.js callbacks (le plus gros ROI)

## Liens

- Auth.js v5 OAuth concepts : https://authjs.dev/concepts/oauth
- Contrat Hub v1.3 §3 (provisioning HMAC) : `docs/CONTRAT-HUB.md`
- Ticket OAuth Phase 1 principal : `todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md`
- Ticket cross-app Prospection : `todo/integrations/2026-05-20-prospection-invite-flow.md`

## Tickets satellites créés 2026-05-20 (registre exhaustif)

### Côté Hub

- ⏳ `todo/2026-05-20-hub-invitation-endpoints.md` — endpoints invitation cross-app
- ✅ `todo/done/2026-05-20-error-pages-ux-polish.md` — custom error pages OAuth (livré 2026-05-20)
- ✅ `todo/done/2026-05-20-account-settings-connected-providers.md` — UI Settings → Connected providers (livré 2026-05-20)
- 🟡 `todo/2026-05-20-oauth-rate-limiting-monitoring.md` — Phase 1 livrée (rate-limit + logger), Phase 2-3 (audit table + alerting Telegram) à découpler
- ✅ `todo/done/2026-05-20-prisma-prevent-orphan-users-cleanup.md` — cleanup users orphelins (dry-run livré 2026-05-20)
- ⏳ `todo/2026-05-20-google-one-tap-landing-pages.md` — Google One Tap popup auto-login (feature growth, dormant)
- ⏳ `todo/2026-05-20-fallback-login-apps-redirect-hub.md` — spec OAuth buttons sur pages login apps

### Côté apps downstream (cross-app)

- `notifuse-veridian/todo/2026-05-20-hub-invitation-flow-multi-membre.md`
- `notifuse-veridian/todo/2026-05-20-add-oauth-buttons-login-page.md`
- `veridian-prospection/todo/2026-05-20-add-oauth-buttons-login-page.md`
- `veridian-analytics/todo/2026-05-20-hub-integration-when-saas-launched.md` (dormant)
- `veridian-analytics/todo/2026-05-20-add-oauth-buttons-login-page.md` (dormant)
- `veridian-cms/todo/2026-05-20-hub-integration-when-saas-launched.md` (dormant)
- `veridian-cms/todo/2026-05-20-add-oauth-buttons-login-page.md` (dormant)

### Côté infra

- `veridian-infra/todo/2026-05-20-nginx-port-443-conflict-tailscale.md` — bug nginx local 443
