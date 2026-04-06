# Hub SaaS Veridian

> Ex Web-Dashboard. Application orchestratrice du SaaS.
> Voir le CLAUDE.md racine (`../CLAUDE.md`) pour la vision globale.

## Ce que c'est

Le Hub gere l'inscription (Supabase Auth), le billing (Stripe),
et le provisioning automatique des apps pour chaque nouveau tenant
(Twenty CRM, Notifuse, Prospection).

## Stack

- Next.js 14 (App Router) + pnpm
- Supabase (Auth + DB) self-hosted
- Stripe (billing, webhooks, plans)
- shadcn/ui + Tailwind

## Structure

```
hub/
├── app/                    # Pages (auth, marketing, dashboard, admin)
├── components/             # React components
├── utils/
│   ├── supabase/           # Client hierarchy (server, client, admin, middleware)
│   ├── stripe/             # Stripe config
│   └── tenants/
│       └── provision.ts    # Provisioning Twenty + Notifuse + Prospection
├── config/
│   └── billing.config.ts   # Source de verite plans/prix
├── scripts/
│   └── billing/            # Sync Stripe, init-stripe.mjs
├── supabase/migrations/    # Schema DB (auth.users, tenants, subscriptions)
├── styles/main.css         # Theme OKLCH (jamais hardcoder les couleurs)
├── Dockerfile              # Multi-stage (deps → builder → runner → dev)
└── middleware.ts            # Session refresh Supabase
```

## Commandes

```bash
cd hub
pnpm install
pnpm dev          # Dev mode
pnpm build        # Build prod
pnpm test         # Vitest
```

## Provisioning flow

```
User Signup → Supabase Auth → provision.ts (parallele)
                                    |
            +-------+-------+-------+
            |       |       |       |
          Twenty  Notifuse  Prospection
          GraphQL  REST     REST
            |       |       |
            v       v       v
        tenants table (user_id, workspace_type, workspace_id, api_key)
```

## Regles

- Les env vars runtime sont injectees via docker-compose (pas de build-args)
- Stripe = source de verite billing. Config dans `config/billing.config.ts`
- Ne jamais hardcoder les couleurs — utiliser les design tokens CSS
- Les migrations Supabase sont dans `supabase/migrations/`
