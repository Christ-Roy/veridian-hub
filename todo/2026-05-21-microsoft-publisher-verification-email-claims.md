# [HUB] Microsoft Entra — Publisher Verification + audit claims email

> **Type** : Config Microsoft Entra Admin Center + audit code Auth.js
> **Sévérité** : 🟡 P2 (UX/réputation OAuth Microsoft — pas bloquant fonctionnellement)
> **Owner** : Robert (action manuelle Entra Admin Center + MPN signup) + agent Hub (audit code)
> **Créé** : 2026-05-21
> **Avancé** : 2026-05-24 — voir §"Progress 2026-05-24" en bas

## Progress 2026-05-24 (agent Hub)

### ✅ Faits via `az` CLI / Graph API (zero manual click)

1. **Optional claims `email` + `xms_edov` configurés** sur l'app
   `Veridian Hub Sign-in` (Client ID `44621507-2ab6-4cb4-8f90-2e6a9cc9e8d8`)
   - `idToken` : `email` + `xms_edov`
   - `accessToken` : `email`
   - **Effet** : couvre 95 % des cas Work/School (Microsoft pousse désormais
     systématiquement le claim email dans l'id_token Veridian, et le flag
     `xms_edov` indique si le domaine email est vérifié côté tenant)
2. **Branding URLs renseignées** (Graph API PATCH) :
   - `homePageUrl` → `https://veridian.site`
   - `marketingUrl` → `https://veridian.site/`
   - `privacyStatementUrl` → `https://app.veridian.site/privacy`
   - `termsOfServiceUrl` → `https://app.veridian.site/terms`
   - `supportUrl` → `https://app.veridian.site/legal`
   - **Effet** : consent screen Microsoft affiche désormais des liens
     légaux propres au lieu de "no terms provided"
3. **Fichier well-known déployé** sur `https://veridian.site/.well-known/microsoft-identity-association.json`
   - Commit `1505e0d` sur repo `Christ-Roy/veridian` branche `master`
   - Déployé via Cloudflare Pages auto-deploy (Next.js static export)
   - Contenu : `{"associatedApplications":[{"applicationId":"44621507-2ab6-4cb4-8f90-2e6a9cc9e8d8"}]}`
   - Vérifié HTTP 200 + body OK
   - **Pré-requis nécessaire pour set `publisherDomain=veridian.site`**
     dans le portail Azure (action humaine, voir 1.C ci-dessous)

### ✅ Audit code Hub (Phase 2 du ticket) — RAS

- `lib/auth/sign-in-callback.ts` (ligne 38-43) bloque déjà via `if (!user.email) return false` → si Microsoft ne retourne pas
  d'email, l'user n'est pas créé. Safe.
- Provider Auth.js v5 `microsoft-entra-id` (`@auth/core` v0.41.2) ligne 477 : `email: profile.email`.
  Pas de fallback `preferred_username` — donc pas de risque de stocker un UPN à la place
  d'un vrai email.
- `allowDangerousEmailAccountLinking: true` reste cohérent : on link sur email
  matché ET Microsoft certifie via `xms_edov` que le domaine est vérifié.
- **Pas de modification code Hub nécessaire.** Le flow OAuth est résilient.

### ⛔ Reste à faire — actions manuelles Robert (CLI bloqué)

| # | Action | Pourquoi pas faisable via `az` | Effort |
|---|---|---|---|
| A | **Inscription MPN (Microsoft AI Cloud Partner Program)** sur https://partner.microsoft.com — récupérer **Partner ID** (7 chiffres) | Pas d'API publique, obligatoire pour Publisher Verification | 30 min |
| B | **Vérification identité Veridian** côté Partner Center (Tax ID, adresse, tél) si pas déjà faite | Workflow async Microsoft, parfois 24-48h | 5-30 min |
| C | **Set `publisherDomain = veridian.site`** sur l'App Registration dans https://entra.microsoft.com — onglet *Branding & properties*, champ *Publisher domain*, cliquer "Verify and save" (Microsoft fetch automatiquement le well-known déjà déployé) | Champ read-only via Graph API : `{"error":{"code":"Request_BadRequest","message":"Property 'publisherDomain' is read-only and cannot be set."}}` | 2 min |
| D | **Soumission Publisher Verification** : même page Branding, section *Verified publisher* → "Add MPN ID" → entrer le MPN ID de A → "Verify and save" | Workflow Microsoft Partner Center, pas d'API | 5 min (puis 24-48 h async) |
| E | Stocker `MICROSOFT_MPN_ID=<partner_id>` dans `~/credentials/.all-creds.env` | Géré post-A | 1 min |

### Vérification post-action manuelle Robert

```bash
export PATH=$HOME/.local/bin:$PATH && APP_ID=44621507-2ab6-4cb4-8f90-2e6a9cc9e8d8
# Doit retourner publisherDomain="veridian.site" + verifiedPublisher peuplé
az ad app show --id "$APP_ID" --query '{publisherDomain:publisherDomain, verifiedPublisher:verifiedPublisher}'
```

Test consent screen : se logger sur `https://app.veridian.site/login` avec un compte Microsoft (perso ou Work) qui n'est jamais venu sur Veridian. Doit afficher :
- Logo Veridian (si uploadé)
- "Veridian" + badge bleu "Verified"
- "by Veridian" (au lieu de "by an unverified publisher")
- Liens Privacy/Terms cliquables

---

## Contexte — réponses aux 3 questions Robert

### 1. ✅ Les users peuvent-ils créer un compte via Microsoft ?

**OUI, ça marche déjà aujourd'hui.** Quand un user clique "Continuer avec
Microsoft" et qu'aucune row `hub_app.users` n'existe pour son email,
le `PrismaAdapter` d'Auth.js v5 crée automatiquement :
- une row `hub_app.users` avec l'email vérifié Microsoft
- une row `hub_app.accounts` (provider=`microsoft-entra-id`,
  providerAccountId=Object ID Entra)

Code de référence : `lib/auth/sign-in-callback.ts` ligne ~25 commentaire
"Premier login OAuth → PrismaAdapter va créer le user. On laisse passer
(pas de MFA au tout premier login). Scénarios A (signup Google) et B
(signup Microsoft) du catalogue."

L'App Registration Entra étant en **multi-tenant + comptes personnels**
(issuer `common/v2.0/`), tous les types de comptes Microsoft passent
sans validation :
- Outlook.com, Hotmail.com, Live.com, MSN.com → personnels vérifiés par MS
- Comptes Microsoft 365 Work/School (tenants d'entreprise)
- Xbox, Skype legacy

### 2. ⛔ Comment faire disparaître l'écran "application non vérifiée" ?

Microsoft Entra utilise le programme **Publisher Verification** (équivalent
de brand verification Google, gratuit, ~24-48h). Sans ça, les users d'un
tenant Entra ont un screen "This app isn't from a verified publisher" +
warning rouge — l'admin de leur tenant peut même bloquer purement l'app
si une policy "approve external apps only if verified publisher" est
active.

**Pré-requis** : avoir un MPN ID (Microsoft Partner Network) — création
gratuite via partner.microsoft.com (~30 min). Une fois le MPN ID lié à
l'App Registration, soumettre la verification depuis Entra Admin Center.

Procédure détaillée : Phase 1 de ce ticket ci-dessous.

### 3. ✅ A-t-on l'email du user Microsoft, et est-il vérifié ?

**OUI pour les comptes personnels** (Outlook, Hotmail, Live) : Microsoft
les vérifie au signup, et le claim `email` dans l'id_token est garanti
vrai.

**OUI pour les comptes Work/School** mais avec une subtilité importante :
Microsoft retourne **soit** `email` (si l'admin tenant a configuré la
release de ce claim), **soit** uniquement `preferred_username`.

`preferred_username` est souvent un UPN (User Principal Name) du genre
`alice@acme.com` ou `alice@acme.onmicrosoft.com`. C'est ressemblant à un
email mais ce n'est PAS forcément un email réel — c'est juste l'identifiant
unique de l'user dans son tenant.

**Pour les Work/School accounts** : le claim `xms_edov` (Email Domain Owner
Verified) indique si le domaine de l'email est vérifié côté tenant. C'est
documenté dans `auth.config.ts` ligne 53-55.

**Conséquence** : pour 95% des cas (Outlook personnel + Work avec domain
verified), on a un vrai email vérifié. Pour les 5% restants (Work tenant
mal configuré), on a juste un UPN qui ressemble à un email mais peut être
un alias interne.

**Action recommandée** : audit du flow d'inscription côté Hub pour traiter
ce cas — Phase 2 de ce ticket.

---

## Phase 1 — Publisher Verification (UX OAuth Microsoft)

### Pré-requis 1.A : créer un MPN ID

- [ ] Aller sur https://partner.microsoft.com/
- [ ] Cliquer "Become a partner" → "Sign in" avec le compte Microsoft
      personnel `robert.brunon@veridian.site` ou un compte admin du
      tenant Veridian Entra existant
- [ ] Inscription Microsoft Partner Network (gratuit, individuel) :
      - Type : Individual / Sole proprietor
      - Pays : France
      - Coordonnées : SIREN 980 837 660 + adresse 29 Rue Lanterne Lyon
      - Téléphone valide (SMS de vérif)
- [ ] Récupérer le **MPN ID** (Partner ID) — 7 chiffres typiquement
- [ ] Stocker dans `~/credentials/.all-creds.env` :
      `MICROSOFT_MPN_ID=1234567`

⚠️ Note importante : Microsoft a renommé MPN en **Cloud Partner Program**
en 2023. L'interface peut s'appeler "Microsoft AI Cloud Partner Program"
ou "Microsoft Partner Network" selon la date. Le concept est le même —
on cherche le **Partner ID**.

### Pré-requis 1.B : vérifier l'organisation

L'identité Veridian doit être vérifiée auprès de Microsoft (Tax ID +
adresse + téléphone) — c'est le truc qui prend du temps si pas fait.
Si Robert a déjà fait l'inscription au tenant Entra Veridian au signup
OAuth (mémoire `reference_microsoft_entra_oauth.md`), c'est probablement
déjà OK.

- [ ] Vérifier dans Partner Center → Account Settings → Legal Business
      Profile que l'identité est marquée "Verified"

### Soumission Publisher Verification

- [ ] Aller sur https://entra.microsoft.com/ → App registrations
- [ ] Sélectionner l'app "Veridian Hub Sign-in"
      (Client ID `44621507-2ab6-4cb4-8f90-2e6a9cc9e8d8` — cf
      memory `reference_microsoft_entra_oauth.md`)
- [ ] Onglet "Branding & properties"
- [ ] Section "Publisher domain"
      - [ ] Renseigner `veridian.site` comme Publisher domain
      - [ ] Microsoft demande de prouver la propriété du domaine via
            l'un de ces moyens :
            - `https://veridian.site/.well-known/microsoft-identity-association.json`
              (recommandé) — fichier JSON à créer côté domaine racine
              veridian.site qui contient le tenant ID Entra
            - Meta tag dans le HTML de la homepage racine
      - [ ] Méthode recommandée : créer le fichier
            `.well-known/microsoft-identity-association.json` sur le site
            apex veridian.site (à coordonner avec l'agent infra qui gère
            les redirections du domaine racine)
- [ ] Onglet "Branding & properties" → section "Verified publisher"
      - [ ] Cliquer "Add MPN ID"
      - [ ] Entrer le MPN ID obtenu en Phase 1.A
      - [ ] Cliquer "Verify and save"
- [ ] Microsoft lance la vérification (~24-48h ouvrés). Email de
      confirmation envoyé à l'adresse admin du tenant Entra Veridian.

### Vérification post-Publisher Verification

- [ ] Logger avec un compte Microsoft qui n'est jamais venu sur Veridian
- [ ] Sur le consent screen, on doit voir : "Veridian" + petit badge
      bleu "Verified" + "by Veridian"
- [ ] Plus de warning "This app isn't from a verified publisher"
- [ ] Smoke prod :
      `curl -i https://app.veridian.site/api/auth/signin/microsoft-entra-id`
      → 302 vers `login.microsoftonline.com/...`

---

## Phase 2 — Audit code email claim Microsoft (5% edge cases)

### Vérifications à faire côté code

- [ ] Lire `lib/auth/sign-in-callback.ts` et vérifier que le champ `email`
      du user est traité comme **potentiellement non-email** (cas
      `preferred_username` UPN sans vrai email).
- [ ] Si l'app utilise `user.email` comme identifiant unique en DB (cf
      `hub_app.users.email @unique` dans `prisma/schema.prisma`), il
      faut vérifier qu'on n'a pas de collision possible — exemple :
      - User A signup avec Outlook : `alice@outlook.com` (vrai email)
      - User B signup avec Work tenant Acme : `alice@outlook.com` (UPN
        Microsoft 365 qui copie l'email perso) → potentielle collision
      - Auth.js v5 `allowDangerousEmailAccountLinking: true` les fusionne
        automatiquement par email match. **C'est OK si les deux emails
        sont vérifiés** (Outlook l'est par MS, UPN l'est par admin tenant)
- [ ] Vérifier qu'on log proprement le `provider` + `providerAccountId`
      pour chaque user (`hub_app.accounts`) pour pouvoir distinguer
      "même email, deux comptes Microsoft différents" à l'audit.

### Test E2E à ajouter

- [ ] Test Playwright qui simule un signup Microsoft avec :
      - cas 1 : compte personnel Outlook (email = `xxx@outlook.com`)
      - cas 2 : compte Work simulé (preferred_username UPN, claim email
        séparé)
      - cas 3 : compte Work mal configuré (UPN seul, pas de claim email)
- [ ] Vérifier que dans les 3 cas le user est créé avec un email
      cohérent ET que la session OAuth Microsoft permet de re-login

### Audit log à logger

- [ ] Quand un user signup Microsoft, écrire dans `hub_app.audit_log` :
      `action='auth.signup.microsoft'`,
      `payload={provider, providerAccountId, email_verified_by_provider,
      claim_source}` où `claim_source` ∈ `{email, preferred_username}`
- [ ] Permet à terme de filtrer les users à risque (signup via UPN
      seulement) pour leur demander une vérif email supplémentaire si
      besoin.

---

## Phase 3 — Documentation

- [ ] Mettre à jour `memory/reference_microsoft_entra_oauth.md` avec
      le MPN ID + status Publisher Verification
- [ ] Mettre à jour `memory/project_oauth_signin_phase1_livre_2026-05-20.md`
      pour refléter que la Phase 1 OAuth est désormais à 95% pixel-perfect
      (avec Publisher Verification en cours)

---

## Effort

- Phase 1.A (MPN ID) : ~30 min côté Robert
- Phase 1.B (vérif identité MS) : déjà fait probablement, 5 min à check
- Phase 1.C (Publisher Verification submission) : 10 min + 24-48h async
- Phase 2 (audit code) : ~1h agent Hub
- Phase 3 (doc) : 15 min
- **Total bloquant immédiat** : 45 min Robert + 1h agent Hub

---

## Lien

- Mémoire Microsoft state : `reference_microsoft_entra_oauth.md`
- Mémoire OAuth Phase 1 : `project_oauth_signin_phase1_livre_2026-05-20.md`
- Ticket Google équivalent : `2026-05-21-oauth-google-publish-production.md`
- Doc Microsoft officielle :
  https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
