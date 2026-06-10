# Hub SaaS Veridian

> ## 🔴 Règle d'or Veridian — zéro contournement (gravée Robert 2026-06-10)
> **Interdit absolu** : cron bricolé, SQLite/store parallèle, job maison pour
> ÉVITER l'API ou la DB réelle de l'app. On travaille AVEC le vrai système :
> coder propre → tester staging → fixer la logique → MAJ DB staging si besoin
> → test lourd → push prod. Un blocage (accès, credential) se débloque via le
> lead, il ne se contourne pas. Détail : CLAUDE.md racine veridian-platform.


> Ex Web-Dashboard. Application orchestratrice du SaaS.
> Voir le CLAUDE.md racine (`../CLAUDE.md`) pour la vision globale.

## Ce que c'est

Le Hub gère l'inscription (Auth.js v5), le billing (Stripe), et le
provisioning automatique des apps pour chaque nouveau tenant (Notifuse,
Prospection). Twenty retiré de la stack 2026-05-18.

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
│   ├── tenants/provision.ts  # Provisioning Notifuse + Prospection
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
                            +-------------+---------+
                            |             |
                         Notifuse    Prospection
                          REST        REST
                            |             |
                            v             v
                       table Tenant (Prisma : userId UUID, workspaceType, ...)
```

L'UUID `User.supabaseUserId` est un nom legacy : c'est juste l'**UUID
bridge** utilisé comme `user_id` côté Notifuse / Prospection. Pas un
appel Supabase.

## Règles

- Les env vars **runtime** sont injectées via docker-compose (pas de build-args).
  Le compose Git de référence : `infra/services/hub/docker-compose.yml`.
- Stripe = source de vérité billing. Config dans `lib/stripe/`.
- Ne jamais hardcoder les couleurs — utiliser les design tokens CSS (OKLCH).
- Les migrations DB sont dans `hub/prisma/migrations/` (Prisma, pas Supabase).
- Pour appeler une autre app du monorepo, utiliser **toujours l'URL publique**
  `https://<app>.app.veridian.site` (cf `07-inter-app-communication.md`).
- Healthcheck `/api/health` doit rester disponible (gate Docker + smoke CI/CD).

## 💰 Pricing & trial

**Source de vérité unique** : `docs/PRICING-VERIDIAN.md` (figé par
Robert 2026-05-21, voir aussi le `CLAUDE.md` racine `../CLAUDE.md`
§"Pricing & trial cross-app").

Tout agent qui touche au pricing, paywall, trial, billing Stripe,
branding, custom domains, limites de plan, webhooks downstream
**DOIT lire ce fichier avant d'agir**. Il définit :

- La **grille de prix** (Free / Pro 29€ / Business 99€ / Enterprise)
- Le **flow trial complet** (5 mails → 2j silence → 15j visible →
  +30j inconditionnel si CB → débit auto ou paywall lecture seule)
- Les **responsabilités cross-app** : Stripe → Hub → apps (PAS
  Stripe → app directement)
- Les **interdits côté code** (pas de mur béton, pas de compteur
  visible, pas de menu grisé)

**Philosophie figée** : générosité maximale. Tout illimité partout.
SEULES différenciations = durée Free 15j + white-label Business+.
L'app ne doit JAMAIS être défigurée par des limites visibles.

### Tickets pricing/trial actifs côté Hub

Ne PAS maintenir une liste de tickets en dur ici — elle pourrit en liens
cassés dès qu'un ticket migre vers `todo/done/`. Le backlog vivant est
injecté en début de session par le hook SessionStart (bloc `§3 CURRENT
REPO`). Pour la vue cross-app : `veridian-platform/TODO.md` (régénéré par
`./scripts/refresh-todo.sh`).

Source de vérité de l'avancement billing/trial :
`docs/PRICING-VERIDIAN.md` §"Implémentations actuelles — Hub" (matrice
⏳/✅ par brique, mise à jour à chaque livraison).

## CI/CD

- `.github/workflows/hub-ci.yml` : test → audit (npm) → docker → **trivy** → deploy-staging → deploy-prod → e2e-prod-smoke → rollback-prod (si fail)
- `.github/workflows/hub-security-cron.yml` : Trivy cron quotidien 3h UTC sur image deployed
- Stack Dokploy : `compose-back-up-online-pixel-nl2k9p`
  - Bascule UI Raw → Git planifiée mais pas encore faite côté Dokploy au 2026-05-13.
    Le compose Git source de vérité existe dans `infra/services/hub/`. Quand
    Robert bascule la stack en mode Git provider + webhook, les changements
    du compose sur main déclenchent un redeploy auto zero-downtime.

Cf `runbooks/services/hub/deploy.md` pour les détails opérationnels.
