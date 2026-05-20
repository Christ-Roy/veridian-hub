# OAuth Sign-in Google + Microsoft sur les 5 apps Veridian (Phase 1)

> **Type** : Chantier cross-app, ticket maître, à cocher au fur et à mesure
> **Owner principal** : agent Hub (le Hub est le SSO central qui propage les sessions vers les autres apps)
> **Owner secondaires** : agents Notifuse, Prospection, CMS, Analytics (pour le câblage côté app)
> **Sévérité** : 🔴 P1 — réduction friction inscription, demande Robert 2026-05-20
> **Effort total estimé** : 2-3 semaines (1 dev à plein temps) ou 4-5 semaines en doucement
> **But #1** : Avoir le **flow de connection Google + Microsoft automatisé** sur les 5 apps. Magic link reste en fallback.
> **Hors scope** : envoi d'email via OAuth (Phase 3 plus tard, quand Veridian aura gagné la confiance de Google après plusieurs mois en prod).
> **Doc de référence** : `docs/oauth/` à la racine (29 pages Google + Microsoft scrapées, grep-able).

---

## ✅ LIVRÉ EN PROD — 2026-05-20 18h00 UTC+2

**Status final Phase 1** : tous les chemins critiques sont en prod et validés
manuellement par Robert.

- ✅ **Google OAuth Sign-in** : 12 test users Gmail autorisés, scope minimal
  `openid email profile`, mode Testing OK pour 100 users max
- ✅ **Microsoft OAuth Sign-in** : App Registration multi-tenant créée via
  `az ad app create`, scope `openid + profile + email + User.Read`, accepte
  tous les comptes Microsoft (Work/School + personnels)
- ✅ **`allowDangerousEmailAccountLinking: true`** sur les 2 providers : un
  user existant Hub (créé via Credentials/magic) peut maintenant se logger
  via Google ou Microsoft sans `OAuthAccountNotLinked`
- ✅ **Secrets** stockés dans `~/credentials/.all-creds.env` + Dokploy compose
  `_kxAHDCv1LhvsdwNRX3Vk` (prod) + GitHub Actions secrets (staging)
- ✅ **Tests validés** :
  - Tests RTL : 10/10 (LoginForm + SignupForm)
  - E2E Playwright staging headfull : 9/9
  - Manuel Robert prod : Google `brunon5robert@gmail.com` ✓ + Microsoft `robert.brunon@veridian.site` ✓

**Scénarios non couverts** : voir ticket dédié
[`todo/2026-05-20-oauth-scenarios-coverage.md`](./2026-05-20-oauth-scenarios-coverage.md)
qui détaille les 13 scénarios A-M et leur priorité de traitement.

**Cross-app Prospection** : voir ticket dédié
[`todo/integrations/2026-05-20-prospection-invite-flow.md`](./integrations/2026-05-20-prospection-invite-flow.md)
qui spécifie le refactor du flow invitation Prospection pour passer par le Hub.

**Reste côté infra (non bloquant pour Phase 1)** :
- Staging Google + Microsoft OAuth : workflow `hub-staging.yml` patch commit
  `b85b6b9` câble les ENV au .env dev server (en cours de redéploy)
- Brand verification Google (optionnel, ~2-3j review) à soumettre si on
  bascule en "In production" (cap 100 users en Testing actuel)
- Publisher Verification Microsoft (optionnel, exige Microsoft AI Cloud
  Partner Program) — skip Phase 1

---

## 🔥 Update agent Hub — 2026-05-20

**Découverte de la reconnaissance terrain** : la Phase 1.C "Backend Hub" du ticket
sous-estime ce qui est déjà en place. Réalité :

- ✅ **Auth.js v5 déjà en place** sur Hub (`auth.ts` + `auth.config.ts`).
- ✅ **Google OAuth déjà branché** (scope `openid email profile`, `prompt=select_account`).
- ✅ **Table `hub_app.accounts` (modèle `Account` Prisma)** existe déjà côté schema Hub
  et stocke nativement les comptes OAuth (provider, providerAccountId, tokens, etc.).
  **➜ Pas besoin de créer la table `oauth_accounts` proposée Phase 1.C.**
- ✅ **`findOrCreateUserFromOAuth`** : géré nativement par `@auth/prisma-adapter`,
  pas besoin de service custom. Le link `accounts.providerAccountId` est unique.
- ✅ **Routes `/api/auth/[...nextauth]`** : un seul handler Auth.js, pas de
  `start/callback` séparés par provider.
- ✅ **Pages `/login` et `/signup`** : déjà fonctionnelles avec bouton Google.
- ✅ **Page `/legal`** : Privacy Policy + CGV intégrées (URL utilisable directement
  dans Consent Screen Google/Microsoft).

**Ce que la session 2026-05-20 a fait** :

- [x] Phase 1.C : ajout `MicrosoftEntraID` provider dans `auth.config.ts`
- [x] Phase 1.D : boutons "Continuer avec Microsoft" dans `LoginForm` + `SignupForm`
      (à côté du bouton Google existant)
- [x] ENV `MICROSOFT_OAUTH_CLIENT_ID` + `_SECRET` câblées dans `compose/prod.yml`,
      `compose/staging.yml`, `infra/.env.example.hub-compose`
- [x] Tests Vitest `__tests__/components/auth/LoginForm.test.tsx` et `SignupForm.test.tsx`
      (couvre Google + Microsoft + Credentials + password mismatch + `allowOauth=false`)
- [x] Convention Auth.js v5 : redirect URI Microsoft = `https://app.veridian.site/api/auth/callback/microsoft-entra-id`
      (pas `/api/auth/microsoft/callback` comme indiqué Phase 1.B)

**Ce qu'il reste — à compléter par Robert (UI cloud propriétaire)** :

- [ ] Phase 1.A Google Cloud setup (projet + Consent Screen + Client ID)
      → secret existe déjà dans `~/credentials/.all-creds.env` (`GOOGLE_OAUTH_CLIENT_ID`),
      reste à valider Consent Screen + ajouter redirect URI `staging` si pas fait
- [ ] Phase 1.B Microsoft Entra setup (Tenant + App Registration + Secret)
      → créer puis stocker `MICROSOFT_OAUTH_CLIENT_ID` + `MICROSOFT_OAUTH_CLIENT_SECRET`
      dans `~/credentials/.all-creds.env` ET dans Dokploy ENV Hub prod + staging
- [ ] Phase 1.I Mise en production (push staging → smoke → promote main)
- [ ] Phase 1.E Propagation session vers autres apps : déjà cablée via auto-login HMAC
      Notifuse (rien à faire). Prospection/CMS/Analytics = tickets cross-app séparés
      (cf §1.E du ticket)
- [ ] Phase 1.F Sécurité : rate limiting Auth.js (à ajouter dans middleware), audit
      table `oauth_signin_events` (optionnel, log structuré suffit pour P1)

---

## Pourquoi maintenant et pourquoi dans cet ordre

Sign-in Google avec scopes **non-sensitive** (`openid + email + profile`) est explicitement exempté de :
- Verification Google obligatoire
- Cap 7-jours sur les refresh tokens en mode Testing (exception spéciale Sign-in, cf. `docs/oauth/sources/google/oauth-overview.md` L292-295)
- Vidéo demo YouTube
- CASA security assessment

Microsoft Sign-in avec `openid + email + profile + User.Read` n'a **aucune** review obligatoire. Publisher verification (badge bleu) est optionnelle.

→ **On peut shipper Phase 1 en prod sous 2-3 semaines sans paperasse Google/Microsoft.**

Phase 3 (envoi email via OAuth Gmail) viendra **bien plus tard** quand on aura :
- 6+ mois d'historique Sign-in sans incident
- Privacy Policy + Terms rodés
- Une marque Veridian crédible vue de Google
- Le temps de monter un dossier CASA Tier 2 propre (~3-15k€, 4-8 sem review)

---

## Décisions Robert (à trancher AVANT de coder)

- [x] **D1 — Architecture** : OAuth centralisé dans Hub (option A). C'est lui qui stocke les tokens, qui propage les sessions vers les autres apps via le pattern auto-login HMAC déjà éprouvé (cf. notifuse-veridian/internal/http/veridian_autologin_handler.go). Pas de duplication par app.
  - *Justification* : le Hub est déjà le SSO de fait via magic link. Centraliser OAuth = même pattern, zéro dette technique.
- [x] **D2 — Scope Google Sign-in** : `openid + email + profile` uniquement. **AUCUN** scope sensitive/restricted en Phase 1.
- [x] **D3 — Scope Microsoft Sign-in** : `openid + email + profile + User.Read` (équivalent strict).
- [x] **D4 — Multi-tenant Microsoft** : oui (sinon impossible d'accepter les comptes Microsoft personnels + Workspace). `Supported account types = Any Entra ID Tenant + Personal Microsoft accounts`.
- [x] **D5 — Magic link reste actif** : Sign-in OAuth = bouton additionnel, pas remplacement. Robert garde magic link comme fallback éternel.

→ Décisions par défaut conservatives. Si Robert veut changer, il édite ce ticket et notifie.

---

## Pré-requis transverses (à faire en S1)

### Privacy Policy publique 🔴 BLOQUANT pour brand-verification optionnelle, recommandé même sans
- [ ] Décider URL canonique : `https://app.veridian.site/privacy` ou `https://veridian.site/privacy` ?
  - Reco : `https://veridian.site/privacy` (top-level, partagée par toutes les apps)
- [ ] Rédiger le contenu (template adapté de `docs/oauth/sources/google/brand-verification.md` section "Privacy Policy")
  - Section dédiée OAuth : "We use Google Sign-In and Microsoft Sign-In to authenticate users. We receive your email address and profile name only. We never read your Gmail, Calendar, or other Google/Microsoft data."
  - Section rétention : "OAuth tokens are stored encrypted at rest and rotated/revoked when you disconnect"
  - Section RGPD : contact DPO, droit à l'effacement
- [ ] Publier sur le site vitrine (skill `create-site` ou page statique sur veridian.site)
- [ ] Vérifier accessibilité publique sans login

### Terms of Service publique 🟡 Recommandé pour brand-verification optionnelle
- [ ] URL canonique : `https://veridian.site/terms`
- [ ] Rédiger (template standard SaaS, peut être un seul fichier pour les 5 apps)
- [ ] Publier + vérifier accès public

### Domain ownership Google Search Console 🔴 BLOQUANT pour brand-verification
- [ ] Vérifier si `veridian.site` est déjà revendiqué en Search Console (probablement oui pour SEO Analytics)
- [ ] Si non : ajouter via TXT record DNS (skill `cloudflare-dns`)
- [ ] Vérifier accès Robert au Search Console pour Veridian

### Logo Veridian aux specs Google + Microsoft 🟡 Rapide
- [ ] PNG 120x120px, fond uni ou transparent, < 1MB, pas de texte
- [ ] Skill `assets` pour récupérer le logo officiel
- [ ] Stocker dans `docs/oauth/assets/logo-veridian-120.png` pour réutilisation

---

## Phase 1.A — Google Cloud setup (configuration sans code)

### Projet GCP dédié
- [ ] Créer projet GCP `veridian-oauth-prod` (ou réutiliser existant si Analytics)
  - Vérifier `~/credentials/.all-creds.env` pour identifier le projet GCP existant Veridian
- [ ] Activer billing (gratuit pour Sign-in, mais Google demande un compte de billing actif)
- [ ] Noter le `PROJECT_ID` dans `~/credentials/.all-creds.env` sous `GCP_OAUTH_PROJECT_ID`

### OAuth Consent Screen
- [ ] Naviguer vers `https://console.cloud.google.com/apis/credentials/consent`
- [ ] User Type = **External** (publique, pas G-Suite-only)
- [ ] App name = **Veridian** (sans le mot "Notifuse"/"Prospection" → c'est le nom de la suite)
- [ ] User support email = `support@veridian.site` (ou personnel Robert si pas encore créé)
- [ ] App logo : uploader le 120x120 préparé plus haut
- [ ] App domain :
  - Application home page : `https://veridian.site`
  - Application privacy policy link : `https://veridian.site/privacy`
  - Application terms of service link : `https://veridian.site/terms`
- [ ] Authorized domains : `veridian.site` (suffit pour couvrir tous les sous-domaines apps)
- [ ] Developer contact info : `robert.brunon@veridian.site`
- [ ] Scopes : ajouter UNIQUEMENT
  - `openid`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
- [ ] Test users : ajouter Robert + 10-15 potes/équipe initialement (cap 100, suffisant pour le run-in)
- [ ] Publishing status : laisser sur **Testing** au début. Switch à **In production** quand on est prêt à ouvrir grand public (immédiat possible vu les scopes non-sensitive, mais on profite du Testing pour valider le flow sans risque).

### OAuth Client IDs (1 par app, ou 1 partagé via Hub ?)
- **Décision architecture** : **1 seul client ID** côté Hub, les autres apps ne touchent JAMAIS à Google. Le Hub fait l'OAuth, génère un token de session Veridian, propage aux apps via le pattern auto-login HMAC existant.
- [ ] Créer **1 OAuth 2.0 Client ID** type "Web application"
  - Name : `Veridian Hub OAuth Client`
  - Authorized JavaScript origins : `https://app.veridian.site`
  - Authorized redirect URIs : `https://app.veridian.site/api/auth/google/callback`
- [ ] Récupérer `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`
- [ ] Stocker dans `~/credentials/.all-creds.env` ET dans Dokploy ENV du Hub prod + staging
- [ ] **Ne pas commiter dans le repo** (vérifier `.gitignore`)

### Brand verification (optionnelle Phase 1)
- [ ] Décider : skip pour Phase 1 (les test users voient un screen "non vérifié" mais peuvent cliquer "Advanced > Continue") ou soumettre brand-verification (~2-3 jours review) ?
  - Reco : skip d'abord, soumettre quand on switch publishing status → **In production**

---

## Phase 1.B — Microsoft Entra setup (configuration sans code)

### Tenant Azure
- [ ] Vérifier si Robert a déjà un tenant Microsoft Entra (probablement non, c'est gratuit, à créer)
- [ ] Créer tenant Veridian : `https://entra.microsoft.com` → Tenants → Create
- [ ] Domaine initial : `veridiansite.onmicrosoft.com` (par défaut)
- [ ] Optionnel : ajouter `veridian.site` comme custom domain (DNS verification, skill `cloudflare-dns`)

### App Registration
- [ ] Entra admin center → App registrations → New registration
- [ ] Name : `Veridian Hub OAuth Client`
- [ ] Supported account types : **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**
- [ ] Redirect URI : type Web → `https://app.veridian.site/api/auth/microsoft/callback`
- [ ] Register → noter `Application (client) ID` et `Directory (tenant) ID`

### Client Secret
- [ ] Certificates & secrets → New client secret
- [ ] Description : `Veridian Hub Prod`
- [ ] Expires : 24 months (max recommandé Microsoft)
- [ ] Copier la **Value** immédiatement (Microsoft ne la ré-affiche jamais)
- [ ] Stocker dans `~/credentials/.all-creds.env` ET dans Dokploy ENV du Hub
- [ ] Créer un calendrier rappel rotation à 23 mois

### API Permissions
- [ ] API permissions → Add a permission → Microsoft Graph → Delegated permissions
- [ ] Ajouter :
  - `openid`
  - `email`
  - `profile`
  - `User.Read`
- [ ] Grant admin consent (bouton bleu en haut de la liste)
- [ ] **Ne PAS** ajouter `Mail.Send` ou autres (c'est Phase 3 plus tard)

### Branding (optionnel mais propre)
- [ ] App registration → Branding & properties
- [ ] Upload logo 120x120
- [ ] Home page URL : `https://veridian.site`
- [ ] Service Terms URL : `https://veridian.site/terms`
- [ ] Privacy Statement URL : `https://veridian.site/privacy`
- [ ] Publisher Verification (badge bleu) : skip Phase 1 (exige compte Microsoft AI Cloud Partner Program, on regardera plus tard si ROI)

---

## Phase 1.C — Backend Hub (code) 🔴 Cœur du chantier

### Architecture cible

```
User → app.veridian.site/signin
         ↓
         [bouton "Continue with Google"]
         [bouton "Continue with Microsoft"]
         [magic link email — fallback existant]
         ↓
GET /api/auth/google/start
  → Génère state CSRF (cookie HttpOnly Secure SameSite=Lax)
  → Redirect vers accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=openid+email+profile&redirect_uri=...&state=...
         ↓
[User consent Google]
         ↓
Google → GET /api/auth/google/callback?code=...&state=...
  → Verify state == cookie state
  → POST oauth2.googleapis.com/token (échange code → access_token + id_token)
  → Verify id_token signature + audience (via Google JWKs)
  → Extract email + email_verified + name + sub (= google_user_id stable)
  → Lookup/create user dans hub_app.users (clé : email)
  → Si nouveau user : créer + linker oauth_account (provider=google, provider_user_id=sub)
  → Si user existant : linker oauth_account si pas déjà fait (idempotent)
  → Créer session Veridian (cookie session existant du Hub)
  → Redirect vers dashboard ou last_visited_app
```

Microsoft : pareil avec `login.microsoftonline.com/common/oauth2/v2.0/authorize` et `login.microsoftonline.com/common/oauth2/v2.0/token`.

### Schéma DB

- [ ] Créer migration `hub_app.oauth_accounts`
  ```sql
  CREATE TABLE oauth_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(20) NOT NULL,  -- 'google' | 'microsoft'
      provider_user_id VARCHAR(255) NOT NULL,  -- sub Google ou oid Microsoft
      email VARCHAR(255) NOT NULL,  -- email au moment du link (audit)
      access_token_enc TEXT,  -- chiffré at-rest, NULL pour Phase 1 (on garde pas)
      refresh_token_enc TEXT,  -- idem, NULL Phase 1
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_user_id)
  );
  CREATE INDEX idx_oauth_accounts_user_id ON oauth_accounts(user_id);
  ```
- [ ] **Phase 1 : on ne stocke PAS les access/refresh tokens** (Sign-in seul → besoin uniquement de vérifier l'identité à l'instant T). Les colonnes existent dans le schéma pour Phase 3.

### Handlers HTTP (Next.js API routes ou équivalent stack Hub)

- [ ] `app/api/auth/google/start/route.ts`
  - Génère state aléatoire (32 bytes crypto.randomBytes → hex)
  - Set cookie `oauth_state` HttpOnly Secure SameSite=Lax Max-Age=600
  - Build URL Google + redirect 302
- [ ] `app/api/auth/google/callback/route.ts`
  - Lit `code` + `state` du querystring
  - Compare `state` au cookie, reject si mismatch (CSRF protection)
  - Échange code → tokens via POST `https://oauth2.googleapis.com/token`
  - Vérifie id_token avec `google-auth-library` (JWKs auto-fetch)
  - Extract `email`, `email_verified`, `name`, `sub`
  - Reject si `email_verified === false`
  - Service `findOrCreateUserFromOAuth(provider='google', sub, email, name)`
  - Créer session Veridian (réutilise le service de session existant du Hub, celui qui gère magic link)
  - Redirect vers `?next=` du state ou `/dashboard`
- [ ] Idem `app/api/auth/microsoft/start/route.ts` et `app/api/auth/microsoft/callback/route.ts`
  - Auth URL : `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
  - Token URL : `https://login.microsoftonline.com/common/oauth2/v2.0/token`
  - id_token issuer : `https://login.microsoftonline.com/{tenant_id}/v2.0`
  - Field email : `email` ou `preferred_username` (Microsoft est inconsistant, gérer les deux)
  - Field sub : `oid` (Object ID, stable cross-tenant) — PAS `sub` (qui change selon contexte multi-tenant)

### Service `findOrCreateUserFromOAuth`

- [ ] Logique :
  1. Lookup `oauth_accounts` par `(provider, provider_user_id)` → si trouvé, return user
  2. Sinon, lookup `users` par `email` :
     - Si existe (user créé via magic link auparavant) → créer la ligne `oauth_accounts` qui link, return user
     - Si pas → créer user + créer oauth_account, return user
  3. Toujours update `oauth_accounts.email` + `updated_at` (audit trail)
- [ ] **Garde-fou anti-takeover** : si email Google n'est pas `email_verified` → reject avec erreur claire ("Please verify your Google email first"). Microsoft n'a pas d'équivalent simple → accepter par défaut mais logger.
- [ ] Tests unitaires : 4 cas (nouveau user, user existant magic link, user existant déjà OAuth, conflit provider_user_id différent même email)

### Library OAuth — choix

- [ ] Évaluer dans cet ordre :
  1. **NextAuth.js v5** (`@auth/core`) — standard React/Next, gère tout, providers Google+Microsoft built-in. **Reco si stack Hub = Next.js**.
  2. **Manuel avec `openid-client`** (lib OpenID Connect officielle) — plus de contrôle, moins de magic.
  3. **Manuel pur** — pas besoin si on a une lib mature.
- [ ] Vérifier que la lib retenue ne stocke pas les tokens dans des cookies (on veut session DB Hub, pas JWT stateless)

### Variables d'environnement Hub

- [ ] Ajouter dans Dokploy compose Hub prod + staging :
  ```
  GOOGLE_OAUTH_CLIENT_ID=<from GCP>
  GOOGLE_OAUTH_CLIENT_SECRET=<from GCP>
  GOOGLE_OAUTH_REDIRECT_URI=https://app.veridian.site/api/auth/google/callback
  MICROSOFT_OAUTH_CLIENT_ID=<from Entra>
  MICROSOFT_OAUTH_CLIENT_SECRET=<from Entra>
  MICROSOFT_OAUTH_REDIRECT_URI=https://app.veridian.site/api/auth/microsoft/callback
  MICROSOFT_OAUTH_TENANT=common  # multi-tenant
  OAUTH_STATE_COOKIE_NAME=veridian_oauth_state
  ```
- [ ] Staging utilise les MÊMES OAuth clients que prod ? → **NON**, créer un set séparé `Veridian Hub OAuth Client (Staging)` côté GCP + Entra avec redirect URI `https://app.veridian.site` swap par staging URL (à définir, probablement `hub.staging.veridian.site` mais à confirmer côté agent Hub)

---

## Phase 1.D — UI Hub (login screen)

- [ ] Page `app/signin/page.tsx` (ou équivalent) :
  - Bouton "Continue with Google" (logo Google officiel, respecter Google Branding Guidelines : `docs/oauth/sources/google/sign-in-with-google-display-button.md`)
  - Bouton "Continue with Microsoft" (logo Microsoft officiel)
  - Séparateur "or"
  - Form magic link (existant)
- [ ] Logos officiels :
  - Google : utiliser le composant officiel `g_id_signin` (Google Identity Services) OU créer un bouton conforme aux specs (couleur exacte `#4285F4`, font Roboto Medium, logo 18x18, ratio padding)
  - Microsoft : suivre `docs/oauth/sources/microsoft/` (logo + couleur `#2F2F2F` background ou bordure noire `#8C8C8C`)
- [ ] Gestion erreurs :
  - `?error=oauth_state_mismatch` → "Session expired, please try again"
  - `?error=oauth_email_not_verified` → "Please verify your email with Google first"
  - `?error=oauth_provider_failed` → "Google/Microsoft is temporarily unavailable, please use magic link"
- [ ] Bouton "Disconnect Google account" dans Settings → Account → Connected accounts (Phase 1.G plus bas, optionnel pour ce sprint)

---

## Phase 1.E — Propagation session vers les 5 apps

Le Hub a maintenant le user authentifié. Les autres apps (Notifuse, Prospection, CMS, Analytics) doivent recevoir cette session.

**Pattern à réutiliser** : auto-login HMAC déjà éprouvé sur Notifuse (cf. `notifuse-veridian/internal/http/veridian_autologin_handler.go`). Le Hub génère un token HMAC self-contained TTL 60s, l'app cible le valide et set sa propre session.

### Pour chaque app cible :
- [ ] **Notifuse** : déjà câblé ✓ (rien à faire, l'auto-login HMAC existe). Vérifier que le flow Hub → Notifuse marche depuis OAuth Google (test end-to-end).
- [ ] **Prospection** : vérifier si l'auto-login HMAC est câblé. Si non → ticket dédié `veridian-prospection/todo/`.
- [ ] **CMS** : Payload 3 a son propre auth → câbler un endpoint magic link cross-app équivalent. Ticket `veridian-cms/todo/`.
- [ ] **Analytics** : multi-tenant, auth via Robert direct ou via Hub ? À clarifier. Probablement Phase 1.5.

### Tickets dérivés à créer après merge Phase 1.A-D
- [ ] `veridian-prospection/todo/2026-XX-XX-auto-login-hub-hmac.md`
- [ ] `veridian-cms/todo/2026-XX-XX-auto-login-hub-hmac.md`
- [ ] `veridian-analytics/todo/2026-XX-XX-auto-login-hub-hmac.md`
- [ ] `notifuse-veridian/todo/2026-XX-XX-test-e2e-oauth-google-via-hub.md` (juste un E2E qui valide que Google → Hub → Notifuse marche)

---

## Phase 1.F — Sécurité et garde-fous

- [ ] **CSRF state cookie** : HttpOnly Secure SameSite=Lax Max-Age=600 (10min)
- [ ] **Nonce** dans id_token (NextAuth.js le gère, sinon ajouter manuellement)
- [ ] **Rate limiting** sur `/api/auth/*/start` : 10 req/min/IP (anti-DoS)
- [ ] **Rate limiting** sur `/api/auth/*/callback` : 30 req/min/IP
- [ ] **Logging structuré** :
  - Login success/failure avec provider, email, IP, user_agent
  - Refus email_verified=false
  - State mismatch (potentiel attaque CSRF)
- [ ] **Alerting** : Telegram si > 50 callback failures / 5 min (signal d'attaque ou provider down)
- [ ] **Audit table** : `hub_app.oauth_signin_events` (insert sur chaque tentative, query pour SIEM plus tard)
- [ ] **Headers sécu standards** sur les routes auth :
  - `Cache-Control: no-store`
  - `X-Frame-Options: DENY` (anti-clickjacking)
  - `Content-Security-Policy` cohérent
- [ ] **PKCE** : NextAuth.js le fait automatiquement. Si manuel, ajouter `code_challenge` + `code_verifier` (S256). Google et Microsoft supportent les deux.
- [ ] **Revocation** : prévoir un endpoint `/api/auth/oauth/disconnect` qui :
  - Supprime la ligne `oauth_accounts`
  - Révoque le refresh token côté provider (Google : POST `oauth2.googleapis.com/revoke`, Microsoft : pas d'endpoint clean, juste delete local)
  - Si c'était le seul moyen de login du user → afficher "Please set a password or magic link first"

---

## Phase 1.G — UX polish (post-MVP, peut être différé)

- [ ] Bouton "Disconnect Google" / "Disconnect Microsoft" dans Settings → Account → Connected accounts
- [ ] Affichage des comptes liés : "Connected with Google (robert.brunon@gmail.com) — connected 2026-XX-XX"
- [ ] Détection email match : si user logge avec Google et qu'un user magic link existe avec le même email, message clair "Your account is already linked"
- [ ] Toast post-login : "Welcome back, Robert!"
- [ ] i18n des messages d'erreur OAuth

---

## Phase 1.H — Tests et validation

### Unitaires
- [ ] Service `findOrCreateUserFromOAuth` : 4 cas couverts
- [ ] Verification id_token : mocks JWKs + cas signatures invalides/expirées
- [ ] State CSRF : match, mismatch, missing
- [ ] Email verified false : reject

### Intégration
- [ ] E2E Playwright : flow Google complet (avec un compte test users dédié `oauth-tester@veridian.site` ou personnel Robert)
- [ ] E2E Playwright : flow Microsoft complet
- [ ] E2E : magic link existant non régressé
- [ ] E2E : Hub → Notifuse auto-login depuis session OAuth Google

### Manuel
- [ ] Test depuis Robert + 5 testeurs ajoutés en Test Users GCP
- [ ] Test Microsoft depuis compte perso + compte Microsoft 365 d'un testeur (multi-tenant)
- [ ] Test fallback magic link toujours dispo
- [ ] Test deconnect Google + re-login

---

## Phase 1.I — Mise en production

- [ ] Merge dev sur `staging` branche Hub → deploy auto staging
- [ ] Tests E2E staging vert
- [ ] Recette manuelle Robert sur staging
- [ ] Trigger auto-promote staging → main → deploy prod
- [ ] Vérifier prod : login Google + Microsoft fonctionne
- [ ] Annoncer aux 10-15 testeurs : "vous pouvez maintenant vous logger via Google/Microsoft sur app.veridian.site"
- [ ] Monitor Telegram alerting + logs sur 48h
- [ ] Si stable 48h → bascule Publishing status GCP de **Testing** → **In production**
  - Soumettre brand-verification au passage (2-3 jours review, sinon les utilisateurs voient "unverified app" screen)
- [ ] Documenter dans `veridian-hub/docs/auth.md` (créer si absent) le flow OAuth complet

---

## Phase 2 — OAuth Microsoft Mail.Send (envoi via Outlook) — PLUS TARD

> **Trigger** : Phase 1 stable depuis 1+ mois, demande client explicite, ou besoin commercial.
> **Pourquoi avant Gmail** : Microsoft `Mail.Send` n'a aucune review obligatoire, ship en 1 semaine.
> **Apps concernées** : Notifuse + Prospection (sending only)
> **Effort** : 1-2 semaines

Ticket dédié à créer le moment venu : `notifuse-veridian/todo/YYYY-MM-DD-oauth-microsoft-mailsend.md` et `veridian-prospection/todo/...`.

---

## Phase 3 — OAuth Gmail Sending — HORIZON LOINTAIN (post-confiance)

> **Trigger** : Veridian a 6+ mois en prod avec OAuth Sign-in stable, Privacy/Terms rodés, traction client réelle, et besoin commercial impératif.
> **Pourquoi maintenant non** : on n'a pas la crédibilité Google nécessaire. CASA Tier 2 (~3-15k€ + 4-8 sem review) demande de montrer une vraie boîte avec process sécu sérieux. Mieux vaut attendre d'avoir la maturité.
> **Effort** : 3-5 semaines dev + 4-12 semaines review Google.

Ticket dédié à créer le moment venu. Pré-requis qui seront alors en place grâce à Phase 1 :
- ✓ Privacy Policy + Terms publiés et rodés
- ✓ Domain ownership vérifié
- ✓ OAuth Consent Screen branding complet
- ✓ Architecture OAuth centralisée dans Hub
- ✓ Pattern verify id_token + refresh token rodé
- ✓ Schéma `oauth_accounts` déjà prêt (colonnes tokens existantes)

Restera à faire :
- Ajouter scope `https://www.googleapis.com/auth/gmail.send`
- Implémenter stockage chiffré tokens (KMS ou champ AES via secret env)
- Implémenter refresh token rotation + handling 401/429
- UI Settings → Sending Accounts (côté Notifuse + Prospection)
- Mailer provider `gmail_oauth` (Notifuse + Prospection)
- Rate limiting par compte (max 400/jour Gmail gratuit, 1500/jour Workspace)
- Vidéo demo YouTube unlisted (30 min OBS Studio le jour J)
- Submission Google brand-verification + sensitive scope verification + restricted scope verification
- Si Google demande CASA Tier 2 : engager Bishop Fox ou Leviathan (~3-15k€)

---

## Annexes

### Doc de référence locale
- `docs/oauth/README.md` — index + tableau décisionnel
- `docs/oauth/sources/google/` — 15 pages Google scrapées (brand-verification, scope-verification, oauth-overview, sign-in guides, gmail-api)
- `docs/oauth/sources/microsoft/` — 14 pages Microsoft scrapées (quickstart-register-app, oauth2-auth-code-flow, scopes, graph-send-mail, publisher-verification)
- Re-scrap si > 30 jours : `python3 docs/oauth/scripts/scrape_google_docs.py && python3 docs/oauth/scripts/scrape_microsoft_docs.py`

### Risques identifiés Phase 1
1. **Email collision** : user A login Google avec `foo@gmail.com`, user B login Microsoft avec `foo@gmail.com` (qu'il a configuré dans Microsoft) → 2 users distincts ou merge ? **Reco** : merge sur email (1 user, 2 oauth_accounts) — c'est le pattern standard.
2. **email_verified false côté Google** : rare mais possible (compte fresh). On reject avec message clair.
3. **Microsoft multi-tenant + comptes B2B/B2C** : un user invité dans plusieurs tenants Microsoft a un `oid` différent par tenant. On utilise `oid` du token (stable) + email (lookup). Vigilance sur les tests avec comptes Microsoft Work.
4. **Refresh token expiré 7 jours en Testing** : NE S'APPLIQUE PAS pour Sign-in pur (exception explicite Google). Confirmé via `docs/oauth/sources/google/oauth-overview.md` L292-295.
5. **Quota Google par projet** : 10 000 token requests/jour par défaut. Largement suffisant pour Phase 1. Si on cap → demande increase gratuite dans Cloud Console.

### Status global

- [ ] **Pré-requis transverses** (Privacy/Terms/Domain/Logo) : 0/4
- [ ] **Phase 1.A** Google Cloud setup : 0/X
- [ ] **Phase 1.B** Microsoft Entra setup : 0/X
- [ ] **Phase 1.C** Backend Hub : 0/X
- [ ] **Phase 1.D** UI Hub login : 0/X
- [ ] **Phase 1.E** Propagation 5 apps : 0/4 apps
- [ ] **Phase 1.F** Sécurité : 0/X
- [ ] **Phase 1.G** UX polish : 0/X (différable)
- [ ] **Phase 1.H** Tests : 0/X
- [ ] **Phase 1.I** Prod : 0/X
- [ ] **Phase 2** Microsoft Mail.Send : not started (déclencheur futur)
- [ ] **Phase 3** Gmail Sending : not started (déclencheur dans 6+ mois)

**Prochaine action** : agent Hub démarre par les pré-requis transverses (Privacy + Terms) en parallèle de Phase 1.A (Google Cloud setup, Robert peut le faire en 30 min via l'UI cloud.google.com).
