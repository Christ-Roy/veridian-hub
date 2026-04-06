# Dashboard Supabase - Synchronisation Billing Twenty

## 🎯 Objectif

**Philosophie** : Chaque service a son propre paywall, synchronisé via les mêmes produits Stripe.

- **Dashboard** : Paywall SaaS global (accès à la plateforme, provisioning des tenants)
- **Twenty** : Paywall CRM (accès aux fonctionnalités CRM avancées, workflows illimités)
- **Synchronisation** : Mêmes produits Stripe, metadata partagés, webhooks relayés

**Avantage** : UX cohérente avec paywalls "classe" indépendants pour chaque service.

---

## 📊 État Actuel

### Architecture Billing

```
┌─────────────────────────────────────────────────────────────────┐
│                     Stripe (Source de Vérité)                    │
│  - Produits: PRO (29€/mois), ENTERPRISE (99€/mois)               │
│  - Metadata Dashboard: index, synced                               │
│  - Metadata Twenty: planKey, productKey, priceUsageBased          │
└───────┬───────────────────────────┬───────────────────────────────┘
        │                           │
        ▼                           ▼
┌───────────────┐           ┌──────────────┐
│  Dashboard    │           │    Twenty    │
│  Supabase      │           │    (CRM)     │
│  ┌───────────┐ │           │ ┌──────────┐ │
│  │ Subscriptions│ │           │ │ billing* │ │
│  │ customers     │ │           │ │ billingPrice* │
│  │ products      │ │           │ │ billingMeter* │
│  │ prices        │ │           │ │ billingSubscription* │
│  └───────────┘ │           │ └──────────┘ │
└───────────────┘           └──────────────┘

* Tables dans le schéma "core" de Twenty DB
```

### Bases de Données

| Base | Port | Schéma Billing | Tables |
|------|------|----------------|--------|
| **Dashboard Supabase** | 5435 | `public` | `customers`, `products`, `prices`, `subscriptions`, `tenants` |
| **Twenty PostgreSQL** | 5434 | `core` | `billingCustomer`, `billingProduct`, `billingPrice`, `billingSubscription`, `billingMeter` |

### Variables Stripe Partagées

```bash
# .env (commun aux deux services)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Dashboard utilise:
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...

# Twenty utilise:
BILLING_STRIPE_API_KEY=${STRIPE_SECRET_KEY}
BILLING_STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
```

---

## 🚧 Améliorations Possibles

### 1. Automatiser la Sync des Metadata Stripe

**État actuel** : Les produits Stripe ont des metadata partagées, mais nécessitent une mise à jour manuelle.

**Amélioration** : Automatiser la mise à jour des metadata lors de la création/modification de produits.

### 2. Synchronisation Automatique (Webhook Relay)

**État actuel** : Twenty nécessite une sync manuelle :
```bash
docker compose exec twenty-server yarn command:prod billing:sync-plans-data
```

**Amélioration** : Relais automatique des webhooks Stripe vers Twenty pour sync en temps réel.

### 3. Webhooks Séparés → Relay Intelligent

**État actuel** :
- Dashboard : Webhook vers `/api/webhooks/stripe` (Supabase)
- Twenty : Webhook vers `/webhooks/stripe` (Twenty Server)

**Amélioration** : Unifier les webhooks via un relai qui notifie intelligemment les deux services.

### 4. UX : Paywalls Indépendants (Feature, pas Bug !)

**État actuel** : Deux interfaces de billing distinctes :
- Dashboard : Page pricing `/pricing` (Next.js)
- Twenty : Page billing `/{workspaceSlug}/settings/billing`

**Note** : C'est une **feature** ! Chaque service a son propre paywall "classe" :
- Dashboard contrôle l'accès à la plateforme SaaS
- Twenty contrôle l'accès aux features CRM

**Amélioration optionnelle** : Tableau de bord unifié montrant tous les abonnements actifs (Dashboard + Twenty + Notifuse).

---

## 🛣️ Roadmap - Synchronisation Intelligente

### 🎯 Philosophie : Paywalls Indépendants Synchronisés

**Principe** : Chaque service gère son propre paywall, mais les produits Stripe sont synchronisés pour éviter la duplication.

```
┌──────────────────────────────────────────────────────────────┐
│                       Stripe API                             │
│  Produits : PRO (29€/mois), ENTERPRISE (99€/mois)             │
│  Metadata : {index, synced, planKey, productKey, ...}      │
└─────┬────────────────────────────────────────┬────────────────┘
      │                                        │
      ▼                                        ▼
┌─────────────┐                          ┌─────────────┐
│  Dashboard  │                          │   Twenty    │
│  Paywall     │                          │   Paywall   │
│              │                          │             │
│  "Abonnez-vous │                          │ "Upgradez   │
│   pour accéder│                          │  pour plus  │
│   à la SaaS"  │                          │  de features"│
└─────────────┘                          └─────────────┘
```

### Phase 1 : Documentation & Architecture (✅ Complété)

- [x] Audit de l'architecture billing actuelle
- [x] Identification des metadata partagées
- [x] Documentation des variables d'environnement
- [x] Mapping des tables Dashboard ↔ Twenty
- [x] **Changement de philosophie** : Unifier n'est pas nécessaire → Paywalls indépendants synchronisés

### Phase 2 : Webhook Relay (Priorité Haute)

**Objectif** : Relay automatique des webhooks Stripe vers Twenty pour sync en temps réel.

**Bénéfices** :
- ✅ Plus besoin de sync manuelle
- ✅ Mise à jour automatique des abonnements Twenty
- ✅ Paywalls indépendants restent autonomes

**Implémentation** : Voir section "Implémentation - Étapes Concrètes" ci-dessous.

### Phase 3 : Dashboard Unifié (Optionnelle)

**Objectif** : Tableau de bord montrant tous les abonnements actifs.

**Fonctionnalités** :
- Vue agrégée : Dashboard SaaS + Twenty CRM + Notifuse
- Statistiques : MRR, churn, actifs
- Actions rapides : Upgrader, Downgrader, Annuler

**Note** : Le paywall de chaque service reste indépendant. C'est juste une vue centralisée.

---

## 🔧 Implémentation - Webhook Relay

```typescript
// /api/webhooks/stripe-relay (Dashboard)
export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  const event = await stripe.webhooks.constructEvent(body, signature, webhookSecret);

  // 1. Traiter côté Dashboard (existant)
  await handleDashboardWebhook(event);

  // 2. Notifier Twenty (nouveau)
  await notifyTwentyBilling(event);

  return Response.json({ received: true });
}

async function notifyTwentyBilling(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'invoice.paid':
      // Appeler l'API Twenty pour sync
      await fetch(`https://twenty.app.veridian.site/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TWENTY_WEBHOOK_SECRET}` },
        body: JSON.stringify(event)
      });
      break;
  }
}
```

#### Option B : Sync via PostgreSQL FDW

Laisser Twenty lire directement les tables Dashboard :

```sql
-- Dans Twenty DB
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

CREATE SERVER dashboard_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (
    host 'supabase-db',
    port '5432',
    dbname 'postgres'
  );

CREATE USER MAPPING FOR twenty
  SERVER dashboard_server
  OPTIONS (user='postgres', password='XXX');

CREATE FOREIGN TABLE dashboard_subscriptions (
  id UUID,
  customer_id UUID,
  status TEXT,
  created_at TIMESTAMPTZ
) SERVER dashboard_server
  OPTIONS (schema_name 'public', table_name 'subscriptions');
```

**Avantage** : Twenty interroge directement les abonnements Dashboard
**Inconvénient** : Requête externe entre containers

#### Option C : Sync API Periodique

Un cron job dans Twenty qui vérifie les mises à jour :

```typescript
// Twenty Worker - Toutes les heures
@Cron('0 * * * *')
async syncBillingFromDashboard() {
  const activeSubscriptions = await this.dashboardApi.getActiveSubscriptions();

  for (const sub of activeSubscriptions) {
    await this.billingSubscriptionService.upsertFromDashboard(sub);
  }
}
```

### Phase 3 : UX Unifiée (À faire)

**Objectif** : Une seule interface de billing pour l'utilisateur.

#### Options :

1. **Embed Twenty Billing dans Dashboard** :
   - Le Dashboard affiche le statut Twenty
   - Lien vers `/settings/billing` pour gérer

2. **Dashboard comme Single Source of Truth** :
   - Supprimer la page billing Twenty
   - Rediriger vers `/pricing` Dashboard

3. **API de Coordination** :
   - Endpoint `/api/billing/status` qui agrège les deux systèmes
   - Frontend unique qui consomme cette API

### Phase 4 : Mise à jour Automatique des Produits (À faire)

```typescript
// Quand on modifie un produit Stripe via CLI
stripe products update prod_XXX \
  -d "metadata[planKey]=PRO" \
  -d "metadata[productKey]=BASE_PRODUCT" \
  -d "metadata[priceUsageBased]=LICENSED"

// Le webhook relais notifie automatiquement Twenty
// → Plus besoin de sync manuelle
```

---

## 🔧 Implémentation - Étapes Concrètes

### Étape 1 : Créer le Webhook Relay (Dashboard)

**Fichier** : `/home/ubuntu/app.veridian/Web-Dashboard/app/api/webhooks/stripe-relay/route.ts`

```typescript
import { headers } from 'next/headers';
import { Stripe } from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const twentyWebhookUrl = process.env.TWENTY_WEBHOOK_URL!; // https://twenty.app.veridian.site/api/billing/webhook

export async function POST(request: Request) {
  const body = await request.text();
  const signature = headers().get('stripe-signature');

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // 1. Logger l'événement
  console.log(`[Stripe Relay] ${event.type}:`, event.id);

  // 2. Traiter côté Dashboard (logique existante à adapter)
  await handleDashboardEvent(event);

  // 3. Relayer vers Twenty pour les événements billing critiques
  const billingEvents = [
    'checkout.session.completed',
    'checkout.session.expired',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
  ];

  if (billingEvents.includes(event.type)) {
    try {
      await relayToTwenty(event);
      console.log(`[Stripe Relay] ✅ Relayed to Twenty: ${event.type}`);
    } catch (err) {
      console.error(`[Stripe Relay] ❌ Failed to relay to Twenty:`, err);
      // Ne pas échouer le webhook Dashboard si Twenty échoue
    }
  }

  return Response.json({ received: true });
}

async function relayToTwenty(event: Stripe.Event) {
  const response = await fetch(twentyWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Twenty-Webhook-Secret': process.env.TWENTY_WEBHOOK_SECRET!,
    },
    body: JSON.stringify({
      event: event,
      source: 'dashboard-relay',
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Twenty webhook failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
```

### Étape 2 : Créer le Endpoint Webhook Twenty

**Fichier** : À créer dans Twenty Server

```typescript
// packages/twenty-server/src/engine/core-modules/billing/controllers/billing-webhook-relay.controller.ts

import { Controller, Post, Body, Headers } from '@nestjs/common';
import { BillingWebhookRelayService } from '../services/billing-webhook-relay.service';

@Controller('billing')
export class BillingWebhookRelayController {
  constructor(
    private readonly billingWebhookRelayService: BillingWebhookRelayService,
  ) {}

  @Post('webhook')
  async handleRelayedWebhook(
    @Body() payload: { event: any; source: string; timestamp: string },
    @Headers('x-twenty-webhook-secret') secret: string,
  ) {
    // Vérifier le secret
    if (secret !== process.env.TWENTY_WEBHOOK_SECRET) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    // Traiter l'événement comme un webhook Stripe normal
    await this.billingWebhookRelayService.processRelayedEvent(payload.event);

    return { received: true };
  }
}
```

### Étape 3 : Variables d'Environnement Ajoutées

```bash
# .env
TWENTY_WEBHOOK_URL=https://twenty.app.veridian.site/api/billing/webhook
TWENTY_WEBHOOK_SECRET=your_random_secret_here
```

### Étape 4 : Activer le Relay dans Dashboard

```bash
# Mettre à jour le webhook Stripe pour pointer vers le relay
stripe webhook update we_XXX \
  --url https://api.app.veridian.site/api/webhooks/stripe-relay
```

---

## 📋 Checklist Déploiement

### Pré-déploiement

- [ ] Tester le webhook relay en local
- [ ] Vérifier que les variables Twenty sont accessibles
- [ ] Sauvegarder les bases de données
- [ ] Documenter les nouveaux endpoints

### Déploiement

- [ ] Déployer le code webhook relay
- [ ] Déployer l'endpoint Twenty
- [ ] Mettre à jour le webhook Stripe
- [ ] Tester avec un paiement réel

### Post-déploiement

- [ ] Vérifier les logs Dashboard (`/api/webhooks/stripe-relay`)
- [ ] Vérifier les logs Twenty (`/api/billing/webhook`)
- [ ] Tester le flux complet : Achat → Dashboard → Twenty
- [ ] Documenter les procédures de rollback

---

## 🔍 Monitoring

### Logs à Surveiller

```bash
# Dashboard
docker compose logs -f api | grep "Stripe Relay"

# Twenty
docker compose logs -f twenty-server | grep "BillingWebhookRelay"
```

### Métriques

- **Latence** : Temps entre webhook Stripe → Twenty
- **Taux de succès** : % de webhooks relayés avec succès
- **Consistance** : Comparaison des abonnements Dashboard vs Twenty

### Alertes

```yaml
# Exemple: Alert si plus de 5 échecs consécutifs
- alert: HighErrorRate
  expr: rate(webhook_relay_errors[5m]) > 5
  for: 10m
  annotations:
    summary: "Les webhooks Twenty échouent de manière critique"
```

---

## 🚀 Rollback Plan

Si la synchronisation échoue :

1. **Revenir au sync manuel** :
   ```bash
   docker compose exec twenty-server yarn command:prod billing:sync-plans-data
   ```

2. **Restaurer le webhook Stripe** vers le Dashboard uniquement :
   ```bash
   stripe webhook update we_XXX --url https://api.app.veridian.site/api/webhooks/stripe
   ```

3. **Désactiver le relay** :
   ```bash
   # Commenter le code relay dans Dashboard
   git revert <commit-relay>
   ```

---

## 📚 Ressources

- **Stripe Webhooks** : https://stripe.com/docs/webhooks
- **PostgreSQL FDW** : https://www.postgresql.org/docs/current/postgres-fdw.html
- **Twenty Billing** : Voir `/home/ubuntu/app.veridian/infra/app/Twenty/scrpit-and-doc/twenty/twenty/`
- **Dashboard Supabase** : Voir `/home/ubuntu/app.veridian/Web-Dashboard/`

---

## 📝 Notes

- **Version** : 1.0.0
- **Date** : 11 janvier 2026
- **Auteur** : Équipe DevOps + Claude AI
- **Statut** : Roadmap en cours de validation
