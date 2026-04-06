# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Vue Globale du Projet

> **Statut**: POC en développement - Version 1.0.0
> **Infrastructure**: Docker Compose avec Traefik
> **Date**: Janvier 2026

### Vision

Plateforme SaaS (Web-Dashboard) distribuant des logiciels open source interconnectés via leurs webhooks et APIs pour créer une stack sales/marketing complète pour les entreprises. IMPORTANT ⚠️⚠️⚠️ **Nous codons uniquement Web-dashboard, et nous utilisons le code des services distribué et mis a jour par la communauté. mais nous devons comprendre leur fonctionnement pour les connecter avec notre orchestrateur Web-dashboard**

**Documentation complète**: Voir `../ARCHITECTURE.md` et `../FEATURES.md`

### Structure du Monorepo

```
app.veridian/
├── infra/                    ← Infrastructure Docker
│   ├── docker-compose.yml        # Services (Supabase, Twenty, Notifuse)
│   ├── .env                      # Variables centralisées
│   └── volumes/supabase/         # Config Supabase
│
├── Web-Dashboard/            ← CE RÉPERTOIRE (Application orchestratrice)
│   ├── app/                      # Next.js App Router (pages)
│   ├── components/               # React components + shadcn/ui
│   ├── utils/                    # Supabase, Stripe, auth, tenants
│   ├── styles/main.css           # Theme OKLCH centralisé
│   └── supabase/migrations/      # Migrations DB
│
├── ARCHITECTURE.md           ← Schémas architecture détaillés
└── FEATURES.md               ← Specs features et roadmap complète
```

### Services Distribués

| Service | Twenty CRM | Notifuse |
|---------|-----------|----------|
| **Maturité** | Production-ready, large communauté | Self-hosted, adaptations requises |
| **API** | GraphQL (`/graphql`) | REST (`/api/*.method`) |
| **Paywall natif** | ✅ Oui (suspension automatique via Stripe) | ❌ Non (middleware requis) |
| **Cleanup auto** | ✅ Cron jobs intégrés (7j warn, 14j soft, 21j hard) | ❌ Manuel uniquement |
| **Multi-tenant** | Schema-per-workspace (`workspace_{id}`) | Database-per-workspace (`app_ws_{id}`) |

**IMPORTANT**: Twenty gère son propre cycle de vie (trial → suspension → suppression). Notifuse nécessite une orchestration externe depuis Web-Dashboard.

📄 **Documentation détaillée**: `../doc/workspace-cleanup.md`

### Architecture Globale

```
┌─────────────────────────────────────────────────────────────────┐
│                      Traefik v3.6.6 (Reverse Proxy)             │
└──────┬──────────────┬──────────────┬──────────────┬─────────────┘
       │              │              │              │
       ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────────┐
│ Web Dashboard│ │ Twenty    │ │ Notifuse    │ │ Supabase      │
│   (Next.js)  │ │  CRM      │ │  Email      │ │   Stack       │
│ Port: 3000   │ │ Port:3000 │ │ Port: 8081  │ │ Kong: 8000    │
└──────────────┘ └──────────┘ └─────────────┘ └──────────────┘
```

### Stack Technique

| Service | Version | Notes |
|---------|---------|-------|
| Web Dashboard | Next.js 14.2.35 | App Router, Turbo Mode |
| Node.js | 20-alpine | Runtime |
| Supabase | Self-hosted | Auth v2.184.0, Studio 2025.12.29 |
| PostgreSQL | 15.14.1.067 | Supabase DB |
| Twenty CRM | v1.14.0 | Server & Worker |
| Notifuse | v22.2 | Email Marketing |
| Redis | 7-alpine | Cache for Twenty |
| Traefik | v3.6.6 | Reverse Proxy |
| Stripe | 14.25.0 | Billing |

### Plans d'Abonnement

**Statut** : ✅ En PRODUCTION (serveur `ssh ovh`)

| Plan | Prix | Durée Trial | Users | Stripe | Statut |
|------|------|-------------|-------|--------|--------|
| **Freemium** | 0€ | 7 jours | 1 | Hors Stripe (code) | ✅ Prod |
| **Pro** | 29€/mois ou 290€/an | - | Illimités | ✅ LIVE | ✅ Prod |
| **Enterprise** | 35€/mois ou 990€/an | - | Multi | ✅ LIVE | ✅ Prod |

✅ Implémenté | 🚧 En cours | ❌ Non implémenté

### Gestion Stripe - Billing as Code

**Architecture** : Configuration centralisée en TypeScript (source de vérité)

```
config/billing.config.ts (SOURCE DE VÉRITÉ)
    ↓ (sync manuelle via script)
Stripe API LIVE (produits + prix avec lookup_keys)
    ↓ (webhooks temps réel)
Supabase DB (cache lecture)
    ↓ (init-stripe.mjs au boot avec filtre namespace)
Frontend Pricing.tsx (data-driven)
```

**Scripts de gestion** : `scripts/billing/`
- `sync-billing-to-stripe.mjs` : Synchronise config → Stripe (idempotent, additive only)
- `view-billing-config.mjs` : Affiche la config complète (Freemium + plans payants)
- `export-stripe-config.mjs` : Export Stripe → JSON (backup)
- `cleanup-obsolete-products.mjs` : Archive les produits obsolètes
- `CLAUDE.md` : Documentation complète

**Workflow de mise à jour** :
```bash
# 1. Modifier config/billing.config.ts
# 2. Tester en dev
node scripts/billing/sync-billing-to-stripe.mjs --env=dev --dry-run
node scripts/billing/sync-billing-to-stripe.mjs --env=dev

# 3. Commit + Push (GitHub Action build image)
git add . && git commit -m "..." && git push

# 4. Déployer en prod
ssh ovh "cd ~/twenty-saas/00-Global-saas/infra && \
  git pull --force && \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml pull dashboard && \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait"
```

**Règles importantes** :
- ✅ **Additive Only** : Le script ne supprime jamais de produits/prix
- ✅ **Versioning** : Pour changer un prix, créer v2 (ex: `veridian_pro_monthly_v2`)
- ✅ **Grandfathering** : Les abonnés existants gardent leur prix v1
- ✅ **Namespace** : Tous les produits Veridian ont `metadata.namespace = "veridian"`
- ✅ **Lookup Keys** : Identifiants stables pour les prix (ex: `veridian_pro_monthly_v1`)

**Variables d'environnement** (dans `../infra/.env`) :
```bash
# Stripe LIVE (production)
STRIPE_SECRET_KEY_LIVE=sk_live_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE=pk_live_...

# Trial period
TRIAL_PERIOD_DAYS=7
NEXT_PUBLIC_TRIAL_PERIOD_DAYS=7

# Cron (cleanup trials)
CRON_SECRET=...

# Twenty Stripe webhook
TWENTY_STRIPE_WEBHOOK_SECRET=whsec_...
```

📄 **Documentation détaillée** : `scripts/billing/CLAUDE.md`

### Flux de Provisionnement

```
User Signup → Supabase Auth → Provisioning Trigger (Parallel)
                                    │
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
    Twenty CRM (GraphQL)                          Notifuse (REST)
    1. signUp()                                   1. rootSignin (HMAC)
    2. signIn()                                   2. createWorkspace()
    3. createWorkspace()                          3. createAPIKey()
    4. activateWorkspace()                        4. Store in `tenants`
    5. createApiKey()
    6. Store in `tenants`
            │                                               │
            └───────────────────────┬───────────────────────┘
                                    ▼
                        User Dashboard (/dashboard)
                        • Twenty: Login token (15min)
                        • Notifuse: Email invitation
```

### Base de Données (Tables Principales)

| Table | Description |
|-------|-------------|
| `auth.users` | Supabase Auth (id, email, encrypted_password) |
| `profiles` | User profile (user_id, full_name, avatar_url) |
| `customers` | Stripe customers (user_id, stripe_customer_id) |
| `subscriptions` | Abonnements (user_id, price_id, status, stripe_subscription_id) |
| `products` | Stripe products (stripe_product_id, name, metadata) |
| `prices` | Stripe prices (product_id, stripe_price_id, amount, interval) |
| `tenants` | Intégrations (user_id, workspace_type, workspace_id, api_key, status) |

### Webhooks & Events

**Stripe Events** → `/api/webhooks`:
- `customer.subscription.created/updated/deleted` → Update subscription status
- `invoice.payment_succeeded/failed` → Billing events
- `product.created`, `price.updated` → Sync products/prices to DB

**Supabase Auth Events**:
- `user.created` → Provision tenants (Twenty + Notifuse)
- `user.deleted` → Cleanup all data (TODO)

### Priorités Techniques

#### MANDATORY (Bloquants v1.0.0)
1. **Cleanup workspaces Free Trial** - Cron job 15 jours, suppression auto
2. **Sync Stripe Plans ↔ Twenty** - Webhook listener, paywall activation
3. **Paywall Notifuse** - Middleware/proxy (pas de paywall natif)

#### HIGH (Importantes v1.0.0)
1. Système d'invitation d'utilisateurs
2. Gestion des rôles et permissions
3. Dashboard Enterprise
4. Upgrade/downgrade fonctionnel

#### MEDIUM (v1.1.0+)
1. Microservice de synchronisation
2. Lead scoring automatique
3. Décroissance du score des leads inactifs
4. Analytics avancés

### Microservice de Synchronisation (Future v1.1.0)

```
Web Dashboard → Microservice Sync → Twenty CRM ↔ Notifuse
                     │
                     ├── Lead Scoring (interactions email → score 0-100)
                     ├── Score Decay (7j: -10%, 15j: -30%, 30j: -50%, 60j: -80%)
                     └── Subscription Sync (Stripe → Twenty paywall)
```

### Roadmap

| Phase | Période | Features Clés |
|-------|---------|---------------|
| **POC** | Q1 2026 | Provisionnement auto, Auth, Dashboard base |
| **v1.0.0** | Q2 2026 | 3 plans, Roles/permissions, Dashboard Enterprise, Paywall |
| **v1.1.0** | Q3 2026 | Microservice sync, Lead scoring, Analytics |
| **v2.0.0** | Q4 2026 | Add-ons marketplace, SSO, Compliance RGPD/SOC 2 |

### Réseau Docker (16 containers)

```
global-saas-network
├── traefik (80/443)
├── web-dashboard (Node 20 Alpine)
├── Twenty Stack: twenty-server, twenty-worker, twenty-redis, twenty-postgres
├── Notifuse Stack: notifuse-api, notifuse-postgres
└── Supabase Stack: kong, auth, rest, storage, realtime, meta, functions, studio, supabase-db
```

### Notes Importantes

- **Notifuse pas de paywall natif** → Solution requise: Proxy/middleware pour bloquer l'accès
- **Pooler Supabase désactivé** → Web Dashboard connecte directement à supabase-db:5432
- **Variables d'environnement** → Centralisées dans `../infra/.env`

---

## Project Overview

**Web Dashboard** - Central orchestrator for a Global SaaS Platform
- **Stack**: Next.js 14, Supabase (Auth + DB), Stripe, shadcn/ui, Docker
- **Purpose**: Manages auth, billing, and auto-provisions **Twenty CRM** + **Notifuse** workspaces
- **Fork of**: https://github.com/vercel/nextjs-subscription-payments

## Features & Roadmap

📄 **Documentation Complète**: Voir `../FEATURES.md` pour la spécification complète des features actuelles et futures, incluant:
- Plans d'abonnement (Free Trial, Starter, Enterprise)
- Gestion des utilisateurs et rôles (multi-tenant)
- Intégrations (Twenty CRM, Notifuse) avec microservice
- Roadmap détaillée par phase
- Priorités techniques (MANDATORY, HIGH, MEDIUM, LOW)

**Statut Actuel**: POC en développement - Version 1.0.0

## Commands

```bash
# Development (runs via Docker from infra directory)
cd ../infra && docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

## Critical Files - DO NOT MODIFY WITHOUT BACKUP

These contain critical business logic:
- `utils/supabase/*` - Supabase client hierarchy (see Architecture below)
- `utils/auth-helpers/*` - Auth logic with tenant provisioning
- `utils/stripe/*` - Stripe config
- `app/api/webhooks/route.ts` - Stripe webhooks (products, prices, subscriptions)
- `utils/tenants/provision.ts` - Twenty + Notifuse provisioning via GraphQL
- `middleware.ts` - Session refresh for all routes

## Architecture

### Route Groups (3 Layouts)

```
app/
├── (auth)/         → Centered layout (signin, signup)
├── (marketing)/    → Navbar + Footer (homepage, pricing, docs)
└── dashboard/      → Sidebar layout, protected routes
```

### Supabase Client Hierarchy

Use the correct client for each context:

| File | Use Case |
|------|----------|
| `utils/supabase/server.ts` | Server Components (RSC) - uses cookies |
| `utils/supabase/client.ts` | Client Components - browser only |
| `utils/supabase/admin.ts` | Server-side admin operations (service role) |
| `utils/supabase/middleware.ts` | Session refresh in middleware.ts |
| `utils/supabase/queries.ts` | Cached queries (getUser, getSubscription, getProducts) |

### Tenant Provisioning Flow

On signup, `provisionTenants(email, password, userId)` creates:
1. **Twenty CRM workspace** via GraphQL API (signUp → signIn → createWorkspace → activateWorkspace → createApiKey)
2. **Notifuse workspace** via REST API (rootSignin with HMAC → createWorkspace → createAPIKey)

Both run in parallel and store credentials in the `tenants` table.

### Environment Variables

**Centralized in** `../infra/.env` (NOT in Web-Dashboard/.env.local)

Build-time (public): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_TWENTY_URL`

Runtime (secrets): `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TWENTY_GRAPHQL_URL`, `NOTIFUSE_API_URL`, `NOTIFUSE_SECRET_KEY`

### Database

**Tables**: `profiles`, `customers`, `products`, `prices`, `subscriptions`, `tenants`
**Migrations**: `supabase/migrations/`
**Subscription filter**: `utils/supabase/queries.ts` excludes Twenty metered products via `metadata->>productKey`

## Styling System

**All styling is centralized in `styles/main.css` using CSS variables.**

### Theme: OKLCH Green/Mint
- Uses OKLCH color space (more accurate than HSL)
- Light/dark modes via `.dark` class
- Font: Outfit with 0.025em letter spacing

### Usage
```tsx
<div className="bg-primary text-foreground">  // ✅ CORRECT
<div className="bg-green-500 text-black">     // ❌ NEVER hardcode colors
```

**Design tokens**: `bg-background`, `bg-card`, `bg-muted`, `bg-primary`, `text-foreground`, `text-muted-foreground`, `border-border`

**Custom classes** (defined in main.css): `page-container`, `input-base`, `navbar`, `footer`, `page-title`, `section-title`

### Changing Theme
Edit variables in `styles/main.css` or paste from https://ui.shadcn.com/themes

## Common Tasks

### Add Protected Page
```tsx
// app/dashboard/new-page/page.tsx
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';

export default async function Page() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/signin');

  return <div className="page-container">Content</div>;
}
```

### Add shadcn Component
```bash
pnpm dlx shadcn@latest add [component]
# Components auto-use design tokens
```

## Known Issues

1. **Tenants provisioned before email verify** - Security risk, TODO: move to post-verify webhook
2. **No loading states during auth** - Poor UX, TODO: add toast notifications
3. **Base image corruption** - Use `--pull` flag when building Docker images
