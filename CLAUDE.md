# Hub SaaS Veridian

> Ex Web-Dashboard. Application orchestratrice du SaaS.
> Voir le CLAUDE.md racine (`../CLAUDE.md`) pour la vision globale.

## Ce que c'est

Le Hub gère l'inscription (Auth.js v5), le billing (Stripe), et le
provisioning automatique des apps pour chaque nouveau tenant (Twenty
CRM, Notifuse, Prospection).

> 📅 Migration Supabase → Auth.js v5 + Prisma : 2026-05-08
> (cf memory `session_2026-05-08_hub_authjs.md`).
> 📅 ENV résiduelles Supabase dégagées du compose : 2026-05-13 (PR #90).
> Hub ne dépend plus de Supabase Auth/API en runtime.

## Stack

- Next.js 15.5.18 (App Router) + pnpm
- Auth.js v5 (Google OAuth + Credentials bcrypt + MFA email)
- Prisma 7 sur Postgres dédié `veridian-core-db` (schema `hub_app`)
- Stripe (billing, webhooks, plans)
- shadcn/ui + Tailwind
- Notifuse fork pour emails transactionnels (mail signup, magic links tenants)

## Structure

```
hub/
├── app/                    # Pages (auth, marketing, dashboard, admin, api)
│   ├── (auth)/             # signup, login, reset, mfa, verify
│   ├── (marketing)/        # pricing, root
│   ├── dashboard/          # workspace, billing, settings, admin, members
│   ├── invite/[token]/     # acceptation invitation workspace
│   └── api/                # routes API, webhooks Stripe + Notifuse
├── auth.ts                 # Auth.js v5 config (providers + callbacks + MFA)
├── auth.config.ts          # Config edge-safe (middleware)
├── middleware.ts           # NextAuth middleware
├── components/             # React components
├── contexts/EnvContext.tsx # Runtime ENV injection (window.__ENV__)
├── lib/
│   ├── auth/               # getCurrentUser, requireUser, userUuid helpers
│   ├── admin/              # check-admin, is-platform-admin
│   ├── prisma/             # Prisma client singleton lazy proxy
│   ├── notifuse/           # NotifuseClient (Hub → Notifuse fork API)
│   ├── stripe/             # Stripe SDK + plans
│   ├── mfa/                # MFA email codes (crypto-sûrs, bcrypt, TTL 10min)
│   └── email/templates/    # Templates HTML inline (Brevo)
├── prisma/
│   ├── schema.prisma       # 15 modèles (User, Workspace, Tenant, Subscription...)
│   └── migrations/         # Migrations Prisma
├── utils/
│   ├── tenants/provision.ts  # Provisioning Twenty + Notifuse + Prospection
│   ├── stripe/prisma-sync.ts # Sync Stripe → Prisma (Product, Price, Subscription)
│   ├── auth-helpers/       # Helpers session
│   └── env.ts, fetch.ts, helpers.ts
├── styles/main.css         # Theme OKLCH (jamais hardcoder les couleurs)
└── Dockerfile              # Multi-stage Node 20-alpine (deps → builder → runner)
```

## Commandes

```bash
cd hub
pnpm install
pnpm dev          # Dev mode (port 3000 par défaut)
pnpm build        # Build prod
pnpm test         # Vitest (150+ tests)
```

## Provisioning flow

```
User Signup (Auth.js) → /api/auth/signup → provision.ts (parallèle)
                                                    |
                            +-------+-------+-------+
                            |       |       |       |
                          Twenty  Notifuse  Prospection
                          GraphQL  REST     REST
                            |       |       |
                            v       v       v
                       table Tenant (Prisma : userId UUID, workspaceType, ...)
```

L'UUID `User.supabaseUserId` est un nom legacy : c'est juste l'**UUID
bridge** utilisé comme `user_id` côté Twenty / Notifuse / Prospection.
Pas un appel Supabase.

## Règles

- Les env vars **runtime** sont injectées via docker-compose (pas de build-args).
  Le compose Git de référence : `infra/services/hub/docker-compose.yml`.
- Stripe = source de vérité billing. Config dans `lib/stripe/`.
- Ne jamais hardcoder les couleurs — utiliser les design tokens CSS (OKLCH).
- Les migrations DB sont dans `hub/prisma/migrations/` (Prisma, pas Supabase).
- Pour appeler une autre app du monorepo, utiliser **toujours l'URL publique**
  `https://<app>.app.veridian.site` (cf `07-inter-app-communication.md`).
- Healthcheck `/api/health` doit rester disponible (gate Docker + smoke CI/CD).

## CI/CD

- `.github/workflows/hub-ci.yml` : test → audit (npm) → docker → **trivy** → deploy-staging → deploy-prod → e2e-prod-smoke → rollback-prod (si fail)
- `.github/workflows/hub-security-cron.yml` : Trivy cron quotidien 3h UTC sur image deployed
- Stack Dokploy : `compose-back-up-online-pixel-nl2k9p`
  - Bascule UI Raw → Git planifiée mais pas encore faite côté Dokploy au 2026-05-13.
    Le compose Git source de vérité existe dans `infra/services/hub/`. Quand
    Robert bascule la stack en mode Git provider + webhook, les changements
    du compose sur main déclenchent un redeploy auto zero-downtime.

Cf `runbooks/services/hub/deploy.md` pour les détails opérationnels.
