# [HUB] Recon terrain — décisions d'architecture pour l'onboarding première connexion

> **Type** : document de décision (recherche, pas de code livré)
> **Créé** : 2026-07-28
> **Ticket de référence** : `todo/2026-07-06-onboarding-premiere-connexion-client.md` (P1)
> **Lié** : `todo/2026-07-06-autologin-cross-app-casse.md` (P1)
> **Statut** : aucune migration appliquée, aucun fichier applicatif modifié.

---

## TL;DR pour décideur

1. **C'est Brevo, pas Resend.** Le ticket P1 se trompe. Rien à installer.
2. **Un flow "définir son mot de passe par email" EXISTE DÉJÀ en prod et fonctionne** pour un
   client sans mot de passe (`/signin/forgot_password` → mail Brevo → `/auth/reset?token=`).
   Le ticket P1 affirme le contraire. Céline aurait pu s'auto-servir. Le vrai manque n'est pas
   le mécanisme, c'est **le TTL (1h), le libellé ("mot de passe oublié" pour une 1re connexion)
   et l'absence de commande CLI qui déclenche le mail**.
3. **Modélisation de l'état** : non à une colonne JSON dans `users`. Reco = **table dédiée
   `user_onboarding` 1:1** avec jalons typés + `metadata Json`.
4. **Trou de sécu trouvé au passage** : `/auth/reset_password` est la seule route d'auth publique
   **sans rate-limit**, alors que le repo a une infra de rate-limiting complète. Un tiers peut
   bombarder la boîte d'un client et cramer le quota Brevo. À corriger dans le même chantier.

---

## Q1 — Quel service d'emailing est réellement branché ? → **BREVO**

**Verdict : Brevo (API HTTP), avec fallback SMTP Lark. Resend n'existe nulle part.**

Preuves :

| Fait | Preuve |
|---|---|
| Point d'envoi unique du Hub | `lib/email/send.ts` — `sendMail()` |
| Transport = API HTTP Brevo | `lib/email/send.ts:11` → `const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'` ; clé lue dans `process.env.BREVO_API_KEY` |
| Fallback | SMTP Lark via `nodemailer` (`SMTP_HOST/USER/PASSWORD`), utilisé seulement si `BREVO_API_KEY` est absente. Sans ni l'un ni l'autre → `throw` explicite |
| Aucune trace de Resend | `package.json` : pas de dépendance `resend`. Zéro occurrence de la chaîne dans tout le repo |
| **Configuré en prod** | `~/nomad-veridian/jobs/saas-prod/hub.nomad.hcl:149` → `BREVO_API_KEY={{ .BREVO_API_KEY }}`. Clé présente dans `~/credentials/.all-creds.env` |
| Déjà utilisé pour de vrai | codes MFA (`lib/email/templates/mfa-code.ts`), mails de trial (`lib/email/templates/trial.ts`), invitations cross-app (`lib/email/templates/cross-app-invitation.ts`), **reset password** (`app/(auth)/auth/reset_password/route.ts`) |

**Notifuse ne joue aucun rôle ici** — et c'est un choix documenté, pas un oubli.
`lib/email/templates/trial.ts:8-13` : « On ne passe PAS par Notifuse pour ces mails : (1) Notifuse
est l'app downstream, pas un service transactionnel Hub ; (2) le Hub a déjà une route Brevo en
place ». Un client suspendu ne doit pas cesser de recevoir les mails de son fournisseur.

**Conséquence d'implémentation** : le futur mail d'onboarding passe par `sendMail()` de
`lib/email/send.ts`. Zéro dépendance à ajouter, zéro variable d'env à créer. Si on branche un
provider magic-link Auth.js, il faut lui fournir un `sendVerificationRequest` custom qui appelle
`sendMail()` — surtout **pas** le transport SMTP par défaut du provider Nodemailer.

---

## Q2 — Comment modéliser l'état d'onboarding ?

### État actuel : heuristique, sans persistance

`app/dashboard/page.tsx:97-102` :

```ts
const hasStartedApp =
  !!tenant?.prospectionProvisionedAt || !!tenant?.notifuseWorkspaceSlug;
const hasInvitedMember = (workspace?._count.members ?? 1) > 1;
```

`app/dashboard/components/OnboardingChecklist.tsx:20-21` l'assume : « pas de colonne
`onboardingCompleted`, donc pas de migration DB ». Conséquences mesurables aujourd'hui :

- L'étape « Personnalisez le nom de votre espace » est **codée en dur `done: false`**
  (`OnboardingChecklist.tsx:68`) : elle ne peut littéralement jamais se cocher.
- La mémoire de progression vit dans `localStorage` (`veridian:onboarding:seen`) : changement de
  navigateur = confettis rejoués, aucune donnée côté serveur.
- **Aucun funnel exploitable** : impossible de répondre à « combien de clients livrés ne se sont
  jamais connectés ? ». C'est précisément la question que pose une livraison client ratée.
- Le composant disparaît dès `hasStartedApp` — donc l'étape la plus critique du nouveau flow
  (« le client a-t-il activé son compte ? ») n'est nulle part.

### Options

| Option | Migration | Requêtable (funnel) | Ajout d'étape | Risque |
|---|---|---|---|---|
| **A** — colonne `onboarding Json` sur `users` (proposition Robert) | 1 seule, triviale | JSONB indexable GIN mais requêtes verbeuses, zéro contrainte | gratuit | dérive de schéma silencieuse ; blob métier mouvant dans la table AUTH, la plus critique du système |
| **B** — colonnes typées sur `users` | 1 par étape ajoutée | excellente | migration à chaque fois | pollue `users` (déjà 12 colonnes) ; friction à chaque évolution |
| **C** — table event-log `onboarding_events(user_id, step_key, completed_at)` | 1 | excellente + historique | gratuit | join + agrégation à chaque rendu dashboard ; sur-ingénierie pour 5 étapes |
| **D (reco)** — table dédiée `user_onboarding` 1:1, jalons typés + `metadata Json` | 1 | excellente | typé si jalon durable, `metadata` sinon | 1 join (indexé, 1:1, négligeable) |

### Recommandation : **option D** (confiance ~85 %)

**Pourquoi D et pas la colonne JSON demandée** : `users` est la table d'authentification. Y coller
un blob métier qui va bouger tous les mois, c'est se garantir une migration risquée le jour où on
voudra en extraire quelque chose, sur la table qu'on a le moins envie de toucher. Une table à part
coûte un `include` Prisma et donne les jalons en colonnes `timestamptz` — donc le funnel se lit en
une requête SQL triviale (« clients invités il y a plus de 7 jours et jamais activés »), ce qui est
exactement l'usage business qui a motivé le ticket.

Et surtout : **c'est déjà la convention du repo**. `TenantTrial`, `TenantApp`, `OauthSigninEvent`,
`ProvisioningLog` suivent tous ce pattern (table dédiée, colonnes typées, `metadata Json` pour le
variable). Une colonne JSON fourre-tout dans `users` serait le seul objet du schéma à ne pas s'y
conformer.

**Alternatives écartées, une ligne chacune** :
- **A** (JSON dans `users`) : requêtes funnel verbeuses, zéro contrainte de type, et on touche la table auth.
- **B** (colonnes typées dans `users`) : même problème de table auth, plus une migration par étape.
- **C** (event-log pur) : bon pour de l'analytics fin, sur-dimensionné pour 5 jalons et impose une agrégation à chaque rendu du dashboard.

### Migration proposée (NON appliquée)

Modèle Prisma à ajouter dans `prisma/schema.prisma` :

```prisma
/// État d'onboarding d'un user Hub — 1:1 avec User.
///
/// Remplace l'heuristique de `app/dashboard/page.tsx` (dérivée de
/// tenant.prospectionProvisionedAt / notifuseWorkspaceSlug) par un état
/// persisté et requêtable. Permet le funnel : "clients invités il y a plus
/// de 7 jours et jamais activés".
///
/// Convention : un jalon durable = une colonne timestamptz (nullable = pas
/// franchi). Une étape expérimentale = une clé dans `metadata`, promue en
/// colonne si elle s'installe.
model UserOnboarding {
  userId String @id @map("user_id")

  /// Lien d'onboarding envoyé au client (mail Brevo).
  invitedAt          DateTime? @map("invited_at") @db.Timestamptz(6)
  /// Le client a cliqué le lien et posé son mot de passe (ou lié un OAuth).
  activatedAt        DateTime? @map("activated_at") @db.Timestamptz(6)
  /// Première app démarrée (Prospection ou Notifuse).
  firstAppStartedAt  DateTime? @map("first_app_started_at") @db.Timestamptz(6)
  /// Un second membre a rejoint le workspace.
  memberInvitedAt    DateTime? @map("member_invited_at") @db.Timestamptz(6)
  /// Le workspace a été renommé (étape aujourd'hui non détectable).
  workspaceRenamedAt DateTime? @map("workspace_renamed_at") @db.Timestamptz(6)
  /// Onboarding considéré terminé (checklist masquée).
  completedAt        DateTime? @map("completed_at") @db.Timestamptz(6)

  /// Étapes expérimentales / contexte (source d'invitation, apps ciblées…).
  metadata Json?

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([activatedAt])
  @@index([completedAt])
  @@map("user_onboarding")
  @@schema("hub_app")
}
```

Plus, côté `model User`, la relation inverse : `onboarding UserOnboarding?`.

SQL correspondant (`prisma/migrations/2026XXXXXXXXXX_add_user_onboarding/migration.sql`) :

```sql
CREATE TABLE "hub_app"."user_onboarding" (
    "user_id"              TEXT NOT NULL,
    "invited_at"           TIMESTAMPTZ(6),
    "activated_at"         TIMESTAMPTZ(6),
    "first_app_started_at" TIMESTAMPTZ(6),
    "member_invited_at"    TIMESTAMPTZ(6),
    "workspace_renamed_at" TIMESTAMPTZ(6),
    "completed_at"         TIMESTAMPTZ(6),
    "metadata"             JSONB,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "hub_app"."user_onboarding"
    ADD CONSTRAINT "user_onboarding_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "hub_app"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_onboarding_activated_at_idx" ON "hub_app"."user_onboarding" ("activated_at");
CREATE INDEX "user_onboarding_completed_at_idx" ON "hub_app"."user_onboarding" ("completed_at");
```

**Backfill** : rétro-remplir `first_app_started_at` depuis
`tenants.prospection_provisioned_at` / `tenants.notifuse_workspace_slug`, et `activated_at` pour
tout user ayant déjà un `account` (n'importe quel provider). Sinon tous les clients existants
reverront la checklist de bienvenue.

**Migration additive et réversible** : aucune colonne existante touchée, aucune donnée déplacée.

---

## Q3 — Mécanismes de token existants : ce qui marche, ce qui est cassé

### ✅ Le mécanisme qui marche déjà — et que le ticket P1 ignore

**`/signin/forgot_password` → `POST /auth/reset_password` → `/auth/reset?token=`**
(`app/(auth)/auth/reset_password/route.ts`, `app/signin/forgot_password/page.tsx`,
`app/(auth)/auth/reset/page.tsx`)

Ce flow est **public, en prod, et gère explicitement le cas du client sans mot de passe** :

```
// app/(auth)/auth/reset_password/route.ts, handleConsume()
} else {
  // User Google-only qui veut ajouter un mot de passe : on crée le compte
  // credentials avec le hash.
  await prisma.account.create({ data: { userId: user.id, type: 'credentials',
    provider: 'credentials', providerAccountId: user.email, access_token: passwordHash } });
}
```

Il crée l'`Account` credentials s'il n'existe pas — donc **le contournement manuel appliqué pour
Céline (INSERT SQL + mot de passe en clair dans un mail) était évitable** : un clic sur « Mot de
passe oublié » aurait fait le travail. Le lien est un token 32 bytes hex stocké dans
`verification_tokens`, TTL 1h, consommé à usage unique, mail envoyé via `sendMail()` Brevo.
Le middleware laisse passer (`auth.config.ts` : `/signin` et `/auth` sont dans `publicPrefixes`).

**Ses limites réelles** (le vrai périmètre du ticket) :
1. TTL **1h** — inutilisable tel quel dans un mail de livraison.
2. Libellé « Mot de passe oublié » : incohérent pour une première connexion, un client livré
   n'ira pas le chercher spontanément.
3. Aucune commande CLI ne le déclenche : le client doit trouver le lien seul sur `/login`.
4. **Aucun rate-limit** (voir Q4, piège n°1).
5. Après le reset, redirection vers `/login` : le client doit retaper le mot de passe qu'il vient
   de créer au lieu d'être connecté. Friction inutile à la fin du parcours.
6. `handleRequest` fait `deleteMany({ where: { identifier: user.email } })` : **tout futur token
   indexé sur l'email brut sera détruit par une demande de reset**. Contrainte de conception à
   respecter (voir la reco).

### ✅ `verification_tokens` — table saine, pattern éprouvé

Utilisée par deux mécanismes qui **ne se marchent pas dessus grâce à un préfixe d'identifier** :
- impersonation : `identifier = 'impersonate:<userId>'` (`lib/auth/impersonation.ts:39`), token
  **stocké hashé SHA-256**, TTL 10 min, `deleteMany` atomique = usage unique garanti ;
- reset password : `identifier = <email>` (pas de préfixe), token **en clair en base**.

C'est le bon réceptacle pour un token d'onboarding, à condition de préfixer l'identifier
(`onboard:<userId>`) — sinon collision avec le `deleteMany` du reset password.

### ⚠️ `/api/invitations/create` — cassé en prod, comme annoncé

- Auth HMAC via `HUB_INVITATION_SECRET_<APP>` (`lib/invitations/hmac.ts`).
- **Confirmé** : 0 occurrence de `HUB_INVITATION_SECRET` dans
  `~/nomad-veridian/jobs/saas-prod/hub.nomad.hcl`, alors que les 4 secrets sont bien injectés en
  staging (`~/nomad-veridian/jobs/saas-staging/hub-staging.nomad.hcl:184-187`). En prod la route
  répond donc **503 not_configured** (comportement documenté dans
  `e2e/prod-smoke/sprint-v14-prod.spec.ts:244-245`).
- C'est de toute façon un endpoint **machine-to-machine app→Hub**, pas un outil d'admin.

### ⚠️ `/api/invitations/[token]/accept` — circulaire, comme annoncé

`app/api/invitations/[token]/accept/route.ts` : `const session = await auth(); if (!user?.id) return 401`.
L'invitation **ne connecte pas**, elle rattache une app à un compte déjà loggé.

**Nuance importante et exploitable** : la page `/invite/[token]` (`app/invite/[token]/page.tsx`)
gère déjà proprement le cas non-connecté — elle affiche `InviteSignInOptions` (Google, Microsoft,
login, « créer un compte » avec email pré-rempli et `returnTo` sur le token). **C'est 70 % de
l'UI de la future page `/onboard/<token>`, déjà écrite et testée**
(`e2e/staging-full/11-invite-page-ux-flow.spec.ts`). À réutiliser, pas à réécrire.

### ⚠️ `hub open` / `hub impersonate` — inutilisables dans un mail, comme annoncé

`lib/auth/impersonation.ts` : TTL 10 min, usage unique, admin-only, session résultante marquée
`impersonated: true` (TTL 1h). Conçu pour du support ponctuel. Le CLI produit d'ailleurs le
disclaimer lui-même (`~/.claude/skills/hub-admin/bin/hub:410` : « Le lien est un magic link
usage-unique »).

**Détail opérationnel** : le CLI `hub` **n'est pas dans le PATH**. Il existe à
`~/.claude/skills/hub-admin/bin/hub` mais `~/bin/hub` n'existe pas, contrairement à `notifuse`,
`twenty`, `analytics`, `mail` qui sont tous symlinkés. `which hub` → introuvable. À corriger
(un `ln -s`, 5 secondes) avant d'écrire quoi que ce soit qui parle de `hub invite`.

---

## Q4 — Les autres pièges (cherchés activement)

### 🔴 1. `/auth/reset_password` n'a AUCUN rate-limit

`app/(auth)/auth/reset_password/route.ts` : aucun import de `lib/auth/rate-limit`. C'est la seule
route d'auth publique dans ce cas — `signup` (`signupLimiter`), les invitations
(`invitationCreateLimiter` / `invitationVerifyLimiter`), l'OAuth, le login credentials et l'admin
API sont tous protégés (12 limiters définis dans `lib/auth/rate-limit.ts`).

Conséquences : n'importe qui connaissant l'email d'un client peut **bombarder sa boîte**, cramer
le quota d'envoi Brevo du Hub, et abîmer la réputation d'envoi du domaine. La protection
anti-énumération (retour 200 systématique) est bien là, mais elle ne protège que de l'énumération.

**À corriger dans le même chantier** — un limiter existe déjà, c'est trois lignes. Ce trou devient
critique dès qu'on met ce flow en avant dans l'onboarding client.

### 🟠 2. Un user créé par l'admin n'a PAS de workspace

`lib/admin/users.ts` (`upsertHubUser`, appelé par `POST /api/admin/users/create`, donc par
`hub users:create`) crée le `User` + son `supabaseUserId` — **et rien d'autre**.
`provisionDefaultWorkspace` (`lib/workspace/provision.ts`) n'est appelé que depuis deux endroits :
l'event Auth.js `createUser` (`lib/auth/create-user-event.ts`, déclenché uniquement à la création
par le PrismaAdapter, donc au signup OAuth) et `app/api/auth/signup/route.ts`.

Résultat pour un client livré via CLI : pas de `Workspace`, pas de `WorkspaceMember`. Le dashboard
retombe sur le libellé générique « Mon espace de travail » et `/dashboard/workspace/members` est
inaccessible — exactement la régression corrigée en 2026-05-21 pour les signups OAuth, jamais
bouchée pour le chemin admin.

**Piège aggravant** : comme le user existe déjà quand il clique le lien d'onboarding, l'event
`createUser` **ne se déclenchera jamais** pour lui. Le workspace ne sera donc pas créé « plus
tard ». La route d'activation devra appeler `provisionDefaultWorkspace` explicitement (elle est
idempotente, c'est safe).

### 🟠 3. Le callback `signIn` est appelé deux fois par un provider magic-link — et il envoie un code MFA

`lib/auth/sign-in-callback.ts` : si `dbUser.mfaEnabled`, le callback **envoie un code MFA** et
redirige vers `/auth/mfa`. Or un provider email Auth.js déclenche `signIn` une première fois à la
**demande** du lien (`verificationRequest`) et une seconde à la **vérification**. Sans garde, un
client avec MFA activé reçoit un code MFA au moment où il demande son lien, code périmé (10 min)
quand il cliquera le lien. Il faut filtrer sur `email?.verificationRequest === true`.

Cet argument pèse dans la reco ci-dessous : le flow maison (`/onboard/<token>`, hors Auth.js)
n'a pas ce problème.

### 🟠 4. Le magic-link Notifuse ne marche pas pour un tenant lié via `hub link`

Confirmation du ticket autologin : `app/api/admin/tenants/link-app/route.ts` ne contient
**aucune** occurrence de `notifuseApiKey` / `notifuseUserEmail`, que
`/api/admin/notifuse/magic-link` exige (sinon 409). Un client livré par `hub link --app notifuse`
tombera sur l'écran de login Notifuse — même avec un onboarding Hub parfait.

**L'onboarding Hub ne suffit donc pas à livrer un client** : sans le fix de
`todo/2026-07-06-autologin-cross-app-casse.md`, le client se connecte au Hub puis se fait
recracher par l'app. Les deux tickets doivent être livrés ensemble, sinon le résultat visible pour
le client est identique à aujourd'hui.

### 🟡 5. Détails à ne pas découvrir en route

- **bcrypt incohérent** : 10 rounds dans `reset_password/route.ts`, 12 dans
  `app/api/account/password/route.ts`. Aligner sur 12.
- **Longueur de mot de passe incohérente** : `min(8)` au reset, `min(6)` au login
  (`auth.ts:24`) et dans `/api/account/password`. Un mot de passe de 7 caractères posé ailleurs
  passe au login mais pas au reset.
- **`/onboard` n'est pas dans `publicPrefixes`** (`auth.config.ts:70-78`). Le fallback de
  `authorized()` est `return true`, donc ça passerait — mais par accident, pas par intention.
  L'ajouter explicitement.
- **`getAuthTypes()` (`utils/auth-helpers/settings.ts`) expose `allowEmail = true`** en dur, et
  `getViewTypes()` annonce une vue `email_signin` qui n'existe nulle part. Héritage du template
  Supabase. À nettoyer si on branche un vrai magic-link, sinon on se retrouvera avec deux notions
  de « connexion par email » qui ne désignent pas la même chose.
- **`OnboardingChecklist` disparaît dès `hasStartedApp`** : l'étape « invitez un membre » n'est
  donc jamais visible cochée. À revoir en même temps que le passage à l'état persisté.

---

## Recommandation d'implémentation (tranchée)

**Construire un flow maison `/onboard/<token>` adossé à `verification_tokens`, PAS un provider
magic-link Auth.js.** Confiance ~80 %.

### Le flow

1. **`POST /api/admin/onboarding/invite`** (auth `authenticateAdmin`, comme les autres routes
   admin) + commande CLI `hub invite <email> [--apps ...] [--ttl 30d]` :
   - `upsertHubUser` (idempotent, déjà écrit) ;
   - `provisionDefaultWorkspace` (idempotent, déjà écrit) → bouche le piège n°2 ;
   - token 32 bytes hex, **stocké hashé SHA-256** dans `verification_tokens` avec
     `identifier = 'onboard:<userId>'` (préfixe obligatoire : protège du `deleteMany` du reset
     password, et reprend exactement le pattern éprouvé de `lib/auth/impersonation.ts`) ;
   - `expires = now + 30j` ;
   - mail via `sendMail()` (Brevo) avec un template dédié dans `lib/email/templates/` ;
   - `UserOnboarding.invitedAt = now()` ;
   - `writeAuditLog(action: 'admin.onboarding.invite')`.
   - **Renvoie l'URL** : Robert peut la coller à la main dans son propre mail plutôt que
     déclencher l'envoi, ce qui est le besoin exprimé dans le ticket.

2. **`GET /onboard/<token>`** — page publique. Réutiliser la structure de
   `app/invite/[token]/page.tsx` (états `valid` / `expired` / `consumed` / `not_found` déjà
   écrits) et `InviteSignInOptions` pour l'option « continuer avec Google ». Le token **n'est pas
   consommé à l'affichage** : le client peut ouvrir le lien plusieurs fois, ce qui est tout
   l'intérêt d'un lien durable.

3. **`POST /api/onboarding/<token>/complete`** — pose le mot de passe (bcrypt 12, même logique
   `find-or-create Account credentials` que `handleConsume`, à factoriser dans
   `lib/auth/set-password.ts` plutôt que dupliquer), supprime le token (atomique, `deleteMany` →
   usage unique à la complétion), pose `emailVerified`, écrit `UserOnboarding.activatedAt`,
   **connecte le client** (le flow finit sur `/dashboard`, pas sur `/login`), audit log.

4. **Filet self-service** : renommer le lien de `/login` en « Première connexion ou mot de passe
   oublié », et **ajouter le rate-limit manquant** sur `/auth/reset_password`. Quand le lien de 30
   jours a expiré, le client se re-sert seul. C'est le vrai correctif du problème de fond posé par
   Robert : « normalement ils devraient avoir accès directement ».

### Pourquoi ce chemin

- **Zéro dépendance nouvelle, zéro variable d'env nouvelle.** Brevo est branché, la table
  `verification_tokens` existe, le pattern token-hashé existe, la page d'invitation existe, la
  logique set-password existe. On assemble du connu.
- **Contourne les deux pièges d'Auth.js** : double appel du callback `signIn` avec envoi de code
  MFA parasite (piège n°3), et TTL/usage-unique imposés par le provider — incompatibles avec un
  lien durable qu'on colle dans un mail.
- **Contrôle total du TTL et du contenu du mail**, ce qui est exactement l'objet du ticket.

### Alternatives écartées, une ligne chacune

- **Provider magic-link Auth.js (Nodemailer + `sendVerificationRequest` custom)** : lien
  usage-unique et court par nature, et fait passer chaque demande dans le callback `signIn`
  (envoi de code MFA parasite) — mauvais outil pour un lien durable, à garder éventuellement en
  self-service plus tard.
- **Étendre `/api/invitations/create`** : endpoint machine-to-machine avec auth HMAC dont le
  secret n'est pas en prod, et dont l'acceptation exige déjà une session — on hériterait de deux
  problèmes pour en résoudre zéro.
- **Rendre `hub open` durable (TTL long)** : transformerait un outil d'impersonation admin en
  porte d'entrée client permanente. Non, pour des raisons de sécurité évidentes.
- **Mot de passe provisoire généré par le CLI** (le contournement Céline, industrialisé) : un
  mot de passe en clair dans un mail, non.

### Ordre de livraison suggéré

1. Rate-limit sur `/auth/reset_password` (3 lignes, corrige un trou de sécu actif) + symlink
   `~/bin/hub`.
2. Migration `user_onboarding` + backfill.
3. Route + CLI `hub invite` + page `/onboard/<token>` + template mail.
4. Bascule de `OnboardingChecklist` sur l'état persisté.
5. **Fix `todo/2026-07-06-autologin-cross-app-casse.md`** — sans lui, un onboarding Hub réussi
   débouche quand même sur un écran de login côté app. Les deux tickets se livrent ensemble.

---

## Ce qui n'a PAS été fait (garde-fous respectés)

- Aucune migration appliquée, aucune écriture en base (prod ou autre).
- Aucun fichier applicatif modifié : ce document est le seul livrable.
- Aucune dépense.
