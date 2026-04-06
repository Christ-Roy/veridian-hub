# Billing as Code - Configuration et Scripts

Ce dossier contient les scripts de synchronisation de la configuration billing vers Stripe.

**Statut** : ✅ **En PRODUCTION** depuis le 2026-01-18
- Déployé sur le serveur de production (`ssh ovh`)
- Testé et validé avec Stripe LIVE
- 2 produits actifs : Pro (29€/mois) + Enterprise (35€/mois)
- Plan Freemium géré dans le code (7 jours gratuit)

## 📚 Vision : Configuration as Code

**Objectif** : Le code est la source de vérité pour la configuration des plans d'abonnement. Toute modification (prix, features, métadonnées UI) passe par une PR et est synchronisée automatiquement vers Stripe via CI/CD.

### Ancienne Architecture (Avant)

```
Stripe Dashboard (Source de vérité manuelle)
    ↓ (webhooks + script init au boot)
Supabase DB (products, prices, subscriptions)
    ↓ (queries)
Frontend (Pricing.tsx avec plan Freemium hardcodé)
```

**Problèmes** :
- Plan Freemium hardcodé dans le composant React
- Configuration éparpillée (Stripe Dashboard + code)
- Pas de versioning des changements de prix
- Difficile de prévisualiser les changements
- Risque de suppression accidentelle de produits/prix

### Nouvelle Architecture (Billing as Code)

```
config/billing.config.ts (Source de vérité)
    ↓ (script de sync idempotent)
Stripe API (via lookup_keys + metadata.internal_id)
    ↓ (webhooks existants inchangés)
Supabase DB (cache de lecture)
    ↓ (queries data-driven)
Frontend (Pricing.tsx data-driven, plus de hardcoding)
```

**Avantages** :
- ✅ Configuration centralisée et versionnée (Git)
- ✅ PR review des changements de prix/features
- ✅ Sync idempotente et safe (additive only)
- ✅ Grandfathering automatique (anciens prix gardés)
- ✅ Namespace pour isoler nos produits
- ✅ Métadonnées UI synchronisées avec Stripe

---

## 📂 Fichiers

| Fichier | Description |
|---------|-------------|
| `config/billing.config.ts` | Configuration TypeScript des plans (source de vérité) |
| `scripts/billing/sync-billing-to-stripe.mjs` | Script de synchronisation idempotent Code → Stripe |
| `scripts/billing/export-stripe-config.mjs` | Utilitaire pour exporter la config Stripe actuelle |
| `scripts/billing/analyze-current-stripe.mjs` | Analyse et génère un rapport de la config actuelle |

---

## 🚀 Usage

### 1. Exporter la configuration Stripe actuelle

Utile pour faire un backup avant migration ou comparer les environnements.

```bash
# Export depuis l'environnement DEV
node scripts/billing/export-stripe-config.mjs dev

# Export depuis PREPROD
node scripts/billing/export-stripe-config.mjs preprod

# Résultat : stripe-config-export-{env}.json
```

### 2. Analyser la configuration actuelle

Génère un rapport détaillé des produits Stripe (actifs, obsolètes, metered).

```bash
node scripts/billing/analyze-current-stripe.mjs
```

### 3. Synchroniser vers Stripe

⚠️ **TOUJOURS tester en dry-run d'abord !**

```bash
# 🔍 DRY-RUN (simulation, aucune modification)
node scripts/billing/sync-billing-to-stripe.mjs --env=dev --dry-run

# ✅ EXÉCUTION RÉELLE (applique les changements)
node scripts/billing/sync-billing-to-stripe.mjs --env=dev

# 🔄 Force la mise à jour même sans changements
node scripts/billing/sync-billing-to-stripe.mjs --env=dev --force
```

**Environnements disponibles** :
- `dev` : Clé STRIPE_SECRET_KEY (test mode)
- `preprod` : Clé STRIPE_SECRET_KEY_PREPROD (test mode)
- `prod` : Clé STRIPE_SECRET_KEY_LIVE (live mode) ⚠️

---

## 🔧 Workflow de Mise à Jour d'un Plan

### Scénario 1 : Modifier le prix d'un plan existant

**❌ INCORRECT** : Modifier le montant directement dans `billing.config.ts`

```typescript
// NE PAS FAIRE ÇA
{
  lookup_key: 'veridian_pro_monthly_v1',
  amount: 3900, // ❌ Modifié de 2900 → 3900
}
```

**✅ CORRECT** : Créer une nouvelle version avec nouvelle lookup_key

```typescript
{
  lookup_key: 'veridian_pro_monthly_v2', // 👈 Nouvelle version
  amount: 3900,
  active: true
},
{
  lookup_key: 'veridian_pro_monthly_v1', // 👈 Ancienne version
  amount: 2900,
  active: false // 👈 Désactivée pour nouveaux abonnements
}
```

**Résultat** :
- Les utilisateurs existants gardent le prix v1 (grandfathering)
- Les nouveaux utilisateurs voient le prix v2
- Aucune suppression = aucun abonnement cassé

### Scénario 2 : Ajouter un nouveau plan

1. Éditer `config/billing.config.ts`
2. Ajouter le plan dans `PAID_PLANS`
3. Définir `internal_id`, `prices`, `stripe_metadata`, `ui_metadata`
4. Tester en dry-run : `node scripts/billing/sync-billing-to-stripe.mjs --env=preprod --dry-run`
5. Exécuter : `node scripts/billing/sync-billing-to-stripe.mjs --env=preprod`
6. Vérifier dans Stripe Dashboard
7. PR → Merge → CI/CD sync vers prod

### Scénario 3 : Modifier les features d'un plan (UI uniquement)

```typescript
ui_metadata: {
  features: [
    'Utilisateurs illimités',
    'Twenty CRM avancé',
    '✨ NOUVEAU : Analytics avancés' // 👈 Ajout d'une feature
  ]
}
```

Puis sync : `node scripts/billing/sync-billing-to-stripe.mjs --env=dev`

---

## 🔐 Règles de Sécurité

### Additive Only

Le script **NE SUPPRIME JAMAIS** de produits ou prix chez Stripe.

- ✅ Création de nouveaux produits/prix
- ✅ Mise à jour des métadonnées
- ✅ Désactivation de prix (active: false)
- ❌ Suppression de produits/prix
- ❌ Modification des montants existants (créer v2 à la place)

### Namespace Isolation

Le script utilise `metadata.namespace = 'veridian'` pour :
- Ignorer les produits Twenty CRM (metered workflows)
- Éviter les conflits avec d'autres services
- Filtrer uniquement nos produits lors de la sync

### Idempotence

Le script peut être lancé plusieurs fois sans effet de bord :
- Matching via `internal_id` (produits) et `lookup_key` (prix)
- Détection des changements avant update
- Logs détaillés des opérations

---

## 📊 Configuration des Plans

Voir `config/billing.config.ts` pour la configuration complète.

### Plans Actuels

| Plan | Prix Mensuel | Prix Annuel | Trial | Statut |
|------|-------------|-------------|-------|--------|
| **Freemium** | 0€ | - | 7 jours | Hors Stripe |
| **Pro** | 29€/mois | 290€/an | - | ✅ Actif |
| **Enterprise** | 35€/mois | 990€/an | - | ✅ Actif + Badge POPULAR |

### Métadonnées Stripe

Synchronisées avec chaque produit :

```typescript
stripe_metadata: {
  planKey: 'PRO',           // Utilisé par Twenty CRM pour limites
  priceUsageBased: 'LICENSED', // vs METERED
  productKey: 'BASE_PRODUCT'   // Exclut les add-ons du frontend
}
```

### Métadonnées UI

Synchronisées en tant que metadata pour le frontend data-driven :

```typescript
ui_metadata: {
  display_order: 1,              // Ordre d'affichage
  badge: 'POPULAR',              // Badge optionnel
  highlighted: true,             // Highlight le plan
  features: [...],               // Liste des fonctionnalités
  cta_text: 'Souscrire'         // Texte du bouton
}
```

---

## 🧪 Tests

### ✅ Tests Effectués (2026-01-18)

**Environnement DEV** :
- ✅ Export config Stripe actuelle (10 produits trouvés)
- ✅ Sync avec lookup_keys : 2 produits + 4 prix synchronisés
- ✅ Update descriptions : Mise à jour correcte des métadonnées
- ✅ Cleanup : 6 produits POC archivés (myproduct, Business Plan, Pro Plan, Starter)
- ✅ Filtre namespace : init-stripe.mjs ne sync que les produits Veridian

**Environnement PRODUCTION** (`ssh ovh`) :
- ✅ Cleanup : 2 produits Starter en double archivés
- ✅ Sync LIVE : 2 produits mis à jour avec namespace + lookup_keys
  - Pro (29€/mois, 290€/an) avec lookup_keys `veridian_pro_monthly_v1` et `veridian_pro_yearly_v1`
  - Enterprise (35€/mois, 990€/an) avec lookup_keys `veridian_enterprise_monthly_v1` et `veridian_enterprise_yearly_v1`
- ✅ Nouveau prix Enterprise mensuel créé (35€/mois)
- ✅ Déploiement Docker : Nouvelle image GitHub Actions déployée
- ✅ Variables env : TRIAL_PERIOD_DAYS, CRON_SECRET, TWENTY_STRIPE_WEBHOOK_SECRET ajoutées
- ✅ Logs : `[Stripe Init] Products already synced - skipping` (filtre namespace OK)

**Résultat** :
- 🎯 Production opérationnelle avec 2 plans actifs (Pro + Enterprise)
- 🎯 Plan Freemium géré dans le code (7 jours gratuit)
- 🎯 Métadonnées UI synchronisées (features, badges, display_order)
- 🎯 Namespace `veridian` appliqué à tous les produits
- 🎯 Lookup keys ajoutées pour identifier les prix de manière stable

### Test 1 : Dry-run sur DEV

```bash
node scripts/billing/sync-billing-to-stripe.mjs --env=dev --dry-run
```

**Vérifier** :
- Les produits existants sont détectés (pas de création en double)
- Les prix existants sont matchés par montant+intervalle
- Les lookup_keys sont ajoutées aux prix existants
- Les métadonnées UI sont ajoutées

### Test 2 : Sync réelle sur DEV

```bash
node scripts/billing/sync-billing-to-stripe.mjs --env=dev
```

**Vérifier** :
- Aller sur Stripe Dashboard → Products
- Vérifier que les métadonnées sont présentes
- Vérifier que les lookup_keys sont ajoutées aux prix
- Tester le checkout depuis /pricing

### Test 3 : Sync sur PRODUCTION (`ssh ovh`)

```bash
# Sur le serveur de production
ssh ovh

# Synchroniser la config Stripe
node ~/twenty-saas/00-Global-saas/Web-Dashboard/scripts/billing/sync-billing-to-stripe.mjs --env=prod --dry-run
node ~/twenty-saas/00-Global-saas/Web-Dashboard/scripts/billing/sync-billing-to-stripe.mjs --env=prod

# Déployer la nouvelle image
cd ~/twenty-saas/00-Global-saas/infra
git pull --force
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull dashboard
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait

# Vérifier les logs
docker logs web-dashboard | grep "\[Stripe Init\]"
```

**Vérifier** :
- ✅ Stripe Dashboard LIVE → Produits avec namespace `veridian`
- ✅ Lookup keys présentes sur tous les prix
- ✅ Métadonnées UI synchronisées
- ✅ Page /pricing affiche les 3 plans (Freemium, Pro, Enterprise)
- ✅ Checkout fonctionnel
- ✅ Webhooks Stripe reçus correctement

---

## 🚨 Dépannage

### Erreur : "Clé Stripe non trouvée"

Vérifier que `../infra/.env` contient les clés :
- `STRIPE_SECRET_KEY` (dev)
- `STRIPE_SECRET_KEY_PREPROD` (preprod)
- `STRIPE_SECRET_KEY_LIVE` (prod)

### Erreur : "Duplicate lookup_key"

Les lookup_keys doivent être uniques globalement dans Stripe.
- Utiliser le préfixe `veridian_` pour éviter conflits
- Utiliser des versions `_v1`, `_v2` pour évolutions

### Produits non détectés

Le script détecte les produits via :
1. `metadata.internal_id` (nouveau format)
2. `metadata.planKey + metadata.productKey = 'BASE_PRODUCT'` (ancien format)

Si un produit n'est pas détecté, vérifier ses métadonnées dans Stripe Dashboard.

### Prix en double créés

Le matching des prix se fait par :
1. `lookup_key` (si définie)
2. `unit_amount + interval + currency + active` (migration)

Si le script crée des prix en double, c'est probablement qu'un prix existant est `active: false`.

---

## 📝 TODO / Roadmap

- [ ] Importer dynamiquement `billing.config.ts` (actuellement hardcodé dans le script)
- [ ] Ajouter un script de rollback (désactiver une version de prix)
- [ ] Intégrer la sync dans la CI/CD GitHub Actions
- [ ] Ajouter des tests unitaires pour `billing.config.ts`
- [ ] Générer automatiquement le JSON-LD SEO depuis la config
- [ ] Migrer le composant Pricing.tsx pour être 100% data-driven

---

## 🔗 Liens Utiles

- Configuration : `/config/billing.config.ts`
- Webhooks Stripe : `/app/api/webhooks/route.ts`
- Composant Pricing : `/components/ui/Pricing/Pricing.tsx`
- Documentation Stripe Lookup Keys : https://stripe.com/docs/api/prices/object#price_object-lookup_key
