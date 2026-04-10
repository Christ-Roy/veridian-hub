# Hub — TODO detaille

> Source de verite strategique : [`../../TODO-LIVE.md`](../../TODO-LIVE.md)
> UI polish solo : [`UI-REVIEW.md`](./UI-REVIEW.md)
>
> Le Hub est le point d'entree SaaS : signup, billing, provisioning, vue workspace.
> Next.js 14, App Router, pnpm, Auth.js (en cours), Stripe, Prisma (partiel), Supabase (legacy).

## Etat actuel

- **Version** : voir `hub/package.json`
- **Dernier deploy prod** : voir `gh run list -w hub-ci.yml`
- **URL prod** : https://app.veridian.site
- **URL staging** : https://saas-hub.staging.veridian.site
- **Sante** : 🟡 (fonctionnel mais incomplet, dette Supabase)

## Architecture

```
hub/
├── app/                  # Next.js App Router
│   ├── (auth)/           # signup, login, invite
│   ├── (dashboard)/      # workspace, billing, settings
│   └── api/              # routes API, webhooks Stripe
├── lib/
│   ├── supabase/         # LEGACY — a migrer (voir Chantiers douloureux TODO-LIVE)
│   ├── stripe/
│   └── prisma/           # partiel, en cours de migration
└── prisma/
    └── schema.prisma
```

## Sprint en cours

### P1.1 — Appliquer le standard cross-SaaS (ref TODO-LIVE)
- [ ] Lire `docs/saas-standards.md` quand cree et auditer le Hub contre la checklist
- [x] Soft delete sur la table `tenants` (migration `supabase/migrations/20260117_add_trial_cleanup_columns.sql` : colonne `deleted_at` + index `idx_tenants_deleted_at`)
- [ ] Audit log `platform_audit_log` Prisma (NOTE: aucun modele Prisma dans le Hub aujourd'hui, cf. alerte sous "Decisions techniques")
- [x] Health check `/api/health` conforme (`app/api/health/route.ts` retourne `{ status, timestamp, service }`)

### P1.4 — OAuth Google + 2FA email opt-in ✅ (2026-04-10, hub-auth-builder)
- [x] Agent MCP Chrome : OAuth Client ID Google Cloud Console cree
  - Scope minimal : `openid email profile`
  - Callbacks : prod + staging + localhost
  - Credentials dans `~/credentials/.all-creds.env` (GOOGLE_OAUTH_CLIENT_ID/_SECRET)
- [x] Auth.js v5 Google provider dans `hub/app/api/auth/[...nextauth]/route.ts`
  (+ CredentialsProvider legacy bridge password dans `hub/auth.ts`)
- [x] Cookies session 3 mois (`maxAge: 60 * 60 * 24 * 90`) dans `auth.config.ts`
- [x] Prisma init + schema `hub_app` sur veridian-core-db (User, Account,
  Session, VerificationToken, MfaCode)
- [x] Table `mfa_codes` Prisma (user_id, code_hash, expires_at, consumed_at)
- [x] Toggle 2FA dans `/dashboard/settings/security` (+ `SecurityMfaToggle.tsx`)
- [x] Page `/auth/mfa` avec input code 6 chiffres + resend (cooldown 30s)
- [x] Template mail "Code de connexion Veridian" HTML inline
  (`lib/email/templates/mfa-code.ts`) via Brevo API HTTP
- [x] Tests vitest : 10 tests (8 lib/mfa + 2 template), 109/109 passent total
- [ ] Tests e2e Playwright (hub n'a pas Playwright, a ajouter en P2)

**Decisions techniques cles** :
- Auth.js v5 cohabite avec Supabase Auth legacy (middleware.ts inchange)
- Prisma 7 utilise `@prisma/adapter-pg` + proxy lazy pour eviter d'ouvrir
  une connexion Postgres au build Next.js
- Rate limit MFA : max 5 codes/heure/user (MfaRateLimitError → HTTP 429)
- Codes 6 chiffres crypto-surs (`crypto.randomInt`), hash bcrypt, TTL 10 min
- `.all-creds.env` mis a jour avec GOOGLE_OAUTH_CLIENT_ID/_SECRET (JAMAIS commit)

### P1.5 — Page membres workspace + invitations [2026-04-10]
- [x] Modele Prisma `WorkspaceMember` (workspace_id, user_id, role, invited_at, joined_at)
- [x] Modele Prisma `Invitation` (workspace_id, email, role, token, expires_at, accepted_at)
- [x] Modele Prisma `Workspace` + enum `WorkspaceRole` (OWNER/ADMIN/MEMBER/VIEWER)
- [x] Page `/workspace/members` : liste + invite + change role + remove
- [x] API `POST /api/workspace/invite` (structure + Brevo integre, stub Prisma)
- [x] API `POST /api/workspace/invite/accept` (acceptation token)
- [x] API `PATCH/DELETE /api/workspace/members/[id]` (change role + remove)
- [x] Page `/invite/[token]` pour acceptation (toutes variantes : valid/expired/consumed/wrong account)
- [x] UI adaptee par role : owner / admin / member (canInvite / canChangeRole / canRemoveMember)
- [x] Tests unitaires : permissions par role (24 tests vitest)
- [x] **Entree UI-REVIEW** creee (2 entrees — members page + invite page)
- **Note** : Routes API en mode stub (PRISMA_READY=false) — activer apres `pnpm prisma migrate dev`
  en staging. Les modeles sont dans `prisma/schema.prisma` prets pour la migration.
- **Correction** : `lib/prisma/index.ts` rendu tolerant a l'absence de DATABASE_URL
  en build time (fix bug hub-auth-builder P1.4). Adapter `@prisma/adapter-pg` installe.

### P1.2 — Dissociation UI "SaaS" / "Services de suivi"
- [ ] Home Hub : deux sections distinctes
  - **Vos SaaS** : Prospection, Twenty, Notifuse
  - **Services de suivi** : Analytics (badge BETA)
- [ ] Composant `AppCard` avec support badge `BETA`
- [ ] Lien Analytics : `https://analytics.app.veridian.site`
- [ ] **Entree UI-REVIEW** a creer apres livraison

## Backlog Hub-specific

- [ ] Audit hot paths Supabase admin API (P0.2) — verifier que le cache 5min est bien applique partout
- [ ] Page `/billing` : historique factures Stripe, upgrade/downgrade plan
- [ ] Page `/settings/workspace` : nom, logo, domaine custom
- [ ] Onboarding post-signup : wizard 3 etapes (workspace name, invite members, choose plan)
- [ ] Email verification obligatoire au signup (via Brevo + token)
- [ ] Password reset flow complet (token email + page reset)

## Bugs connus

- [ ] `checkTrialExpired = return false` en prod (hack P0.1) — le trial ne bloque plus personne
- [ ] Pas de validation email au signup (on peut creer un compte avec un email bidon)

## Decisions techniques

- **⚠️ ALERTE PRISMA 2026-04-10** : audit de la codebase confirme qu'il n'y a AUCUN
  fichier `.prisma` dans `hub/`. Le Hub est 100% Supabase SQL (9 migrations dans
  `supabase/migrations/`). Les sprints P1.4 et P1.5 presupposent l'existence de Prisma
  pour declarer `WorkspaceMember`, `Invitation`, `mfa_codes`. **Prerequis** : le teammate
  qui attaque P1.5 doit d'abord initialiser Prisma dans le Hub (schema + migration baseline
  sur la DB Postgres existante ou une DB dediee Hub). A clarifier avec Robert : on rajoute
  un Postgres dedie Hub (comme Prospection) ou on branche Prisma sur la Supabase existante
  via `DATABASE_URL` direct ?
- **Auth.js vs Supabase Auth** : migration vers Auth.js en cours. Supabase reste legacy
  tant que la decommission n'est pas lancee (voir chantier douloureux dans TODO-LIVE).
- **Cookies 3 mois** : decision explicite pour eviter que les tenants perdent leur compte
  facilement. Le 2FA email opt-in compense pour la securite.
- **Pas d'impersonate au debut** : trop risque, reporte en P3.6 quand le SSO avance sera pret.
- **Twenty = hands-off** : aucun fork, uniquement API GraphQL. Custom features dans le Hub.

## Notes agents (chantiers en cours)

_Section mise a jour par les agents au fil de l'eau. Indiquer : qui bosse sur quoi,
blockers, questions en attente pour Robert._

**2026-04-10 — hub-members-builder (P1.5)** :
- Livraison en mode "stub Prisma" : toute la structure est en place (pages, API, types,
  composants UI, tests), mais les routes API retournent 503 tant que `PRISMA_READY=false`.
- Pour activer : basculer `PRISMA_READY=true` dans les 3 routes + lancer
  `pnpm prisma migrate dev --name init_hub_workspaces` sur la DB staging.
- Bug corrige dans `lib/prisma/index.ts` : le client Prisma plantait au build
  quand DATABASE_URL etait absent. Fix = fallback sans adapter.
- A discuter : faut-il creer le Workspace automatiquement a la creation du tenant
  (dans provision.ts) ou a la premiere visite /dashboard/workspace/members ?

## Recently shipped

- **2026-04-10** — Audit sync TODO : `/api/health`, `tenants.deleted_at`, `/api/webhooks` Stripe, `billing.config.ts` plans, `/api/admin/*` deja en place et non suivis dans la TODO
- **2026-04-07** — `.env.example` mis a jour, docs legacy archives
- **feat preexistante (hors TODO)** — `/api/admin/impersonate` deja implemente (prevu en P3.6 dans TODO-LIVE, a repositionner)
- **feat preexistante (hors TODO)** — `/api/prospection/regenerate-login` + colonnes `prospection_provisioned_at` / `prospection_login_token` sur tenants
