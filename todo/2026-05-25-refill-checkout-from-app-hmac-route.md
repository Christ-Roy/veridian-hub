# [HUB] Refill leads — nouvelle route HMAC `checkout-from-app` + forward filters

> **Type** : Extension API billing — coordination cross-app
> **Sévérité** : 🟡 P1 — bloquant pour la feature refill ICP Prospection
> **Owner** : agent Hub
> **Créé** : 2026-05-25 par team-lead Hub
> **Demandeur** : Robert (via vision refill ICP filtres fins)
> **Refs** :
> - Ticket Prospection parent : `veridian-prospection/todo/2026-05-25-refill-leads-page-native-icp.md`
> - Route actuelle : `app/api/billing/refill-leads/checkout/route.ts`
> - Dispatcher actuel : `utils/stripe/dispatcher.ts` (ou équivalent)
> - Contrat : `docs/CONTRAT-BILLING.md` §8.4

---

## 0. Contexte

Prospection veut une **page native riche refill** avec configurateur ICP
(secteur, géo, taille, qualifiers). L'UI est côté Prospection mais le
backend Stripe reste côté Hub (CONTRAT-BILLING §8.4 — frontière business).

Aujourd'hui la route `POST /api/billing/refill-leads/checkout` exige une
**session user** (gated `requireUser`). Pour que Prospection puisse
initier le checkout côté Hub via HMAC, il faut **une route équivalente
HMAC entrante**.

## 1. Livrable 1 — Nouvelle route `POST /api/billing/refill-leads/checkout-from-app`

### Spec

- **Path** : `app/api/billing/refill-leads/checkout-from-app/route.ts`
- **Auth** : HMAC Pattern A entrant (`<APP>_HUB_API_SECRET` — réutilise
  `PROSPECTION_HUB_API_SECRET` existant, pas de nouveau secret)
- **Body Zod** :
  ```ts
  {
    tenant_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(100_000),
    plan: z.enum(['freemium','pro','business']),  // plan local Prospection
    filters_json: z.record(z.unknown()).optional(), // JSON brut (Prospection le valide)
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
    contract_version: z.literal('2.1'),
  }
  ```
- **Réponse 200** : `{ url, sessionId, amount_cents, quantity, tier }`
  (même shape que la route existante)
- **Réponses 4xx** :
  - 401 invalid HMAC
  - 400 invalid body (Zod fail)
  - 404 tenant_not_found (cf ticket drift cross-app
    `2026-05-25-tenant-drift-cross-app-detected.md`)
  - 422 stripe_session_failed (Stripe rejette)
  - 503 stripe_not_configured

### Logique

Wrappe la logique existante de la route session-gated mais avec
substitution auth :

```ts
// Au lieu de:
const userId = await requireUser(); // SESSION
// On a:
const { app, secret_valid } = await verifyHubInboundHmac(request); // HMAC
if (!secret_valid || app !== 'prospection') return 401;

// Ownership check : le tenant doit appartenir à l'app appelante
const tenant = await prisma.tenant.findFirst({
  where: { id: body.tenant_id, deletedAt: null },
});
if (!tenant) return 404;
// Optionnel : check que tenant.prospection_plan === body.plan pour audit
```

Le reste de la création Stripe Checkout est identique :
- `resolveStripeCustomerId(userId)` (lookup via `tenant.user_id` → users.id)
- `priceRefillCents(plan, quantity)` (shared/pricing)
- `stripe.checkout.sessions.create({ ... metadata: { kind, app, hub_tenant_id, quantity, refill_tier, owner_email, **filters_json** } })`

**Stockage `filters_json`** :
- Option A (simple) : poser dans `metadata.filters_json` (limite Stripe = 500 chars par valeur, 50 keys max). Si JSON > 500 chars : truncate ou store en DB Hub avec ref.
- Option B (durable) : nouvelle table `hub_app.checkout_filters` avec ref `(session_id, filters_json)`, et metadata Stripe ne contient que `filters_ref_id`. Plus propre mais 1 query supplémentaire au webhook.
- **Reco** : Option A pour v1 (truncate à 500 chars + warning log si > 500). Migration vers Option B si on rencontre la limite.

## 2. Livrable 2 — Dispatcher webhook étendu

Modifie `utils/stripe/dispatcher.ts` (ou le handler `checkout.session.completed`) :

```ts
if (session.metadata.kind === 'refill_leads') {
  const filtersJson = session.metadata.filters_json
    ? JSON.parse(session.metadata.filters_json)
    : undefined;

  await dispatchCreditLeads({
    app: session.metadata.app,
    tenant_id: session.metadata.hub_tenant_id,
    body: {
      quantity: parseInt(session.metadata.quantity, 10),
      source: 'purchase',
      idempotency_key: ...,
      stripe_payment_id: session.payment_intent,
      contract_version: filtersJson ? '2.1' : '2.0',
      ...(filtersJson && { filters: filtersJson }),
    },
  });
}
```

**Backward compat** :
- Si pas de `filters_json` (checkout depuis page Hub générique, ou avant
  la migration) → `contract_version: '2.0'` + pas de `filters` dans body
- Si `filters_json` présent → `contract_version: '2.1'` + `filters` dans body

L'app downstream (Prospection) doit accepter les 2 versions.

## 3. Livrable 3 — Doc CONTRAT-BILLING v2.1

Mettre à jour `docs/CONTRAT-BILLING.md` :

- §8.4 : ajouter la nouvelle route `checkout-from-app` dans la matrice
  des routes Hub
- §8.4 : documenter le shape `filters_json` étendu dans metadata Stripe
- Bump version contrat 2.0 → 2.1 (uniquement sur la sous-section refill,
  le reste reste v2.0)
- Ajouter section "Routes HMAC entrantes Hub" qui liste les routes que
  les apps peuvent appeler via HMAC (cette nouvelle + les futures)

## 4. Tests Nuclear

- `__tests__/api/billing/refill-leads/checkout-from-app.test.ts` :
  - 401 sans HMAC
  - 401 HMAC valid mais app non whitelisted
  - 400 body invalid
  - 404 tenant_not_found
  - 200 sans filters_json (backward compat)
  - 200 avec filters_json valide (forward dans metadata Stripe)
  - 200 avec filters_json > 500 chars (truncate + warning log)
  - 503 si Stripe pas configuré
- `__tests__/lib/stripe/dispatcher-refill-filters.test.ts` :
  - Webhook avec metadata.filters_json → body credit-leads avec filters + contract_version 2.1
  - Webhook sans metadata.filters_json → body credit-leads sans filters + contract_version 2.0

## 5. Definition of done

- [ ] Route `/api/billing/refill-leads/checkout-from-app` livrée
- [ ] Dispatcher webhook étendu pour forward filters
- [ ] Doc CONTRAT-BILLING v2.1 publiée
- [ ] Tests Nuclear couvrant les 10 cas
- [ ] Migration secret HMAC : vérifier que `PROSPECTION_HUB_API_SECRET`
  est posé en prod ET staging (devrait déjà être OK, cf fix
  bypass-rate-limit du sprint précédent)
- [ ] Smoke test bout-en-bout : Prospection HMAC call → Hub create session
  → webhook simulé → dispatcher avec filters → Prospection credit avec
  lot filtré
- [ ] Coordination ticket Prospection :
  `veridian-prospection/todo/2026-05-25-refill-leads-page-native-icp.md`
  doit être lancé en parallèle ou avant pour matcher le contrat HMAC

## 6. Contraintes

- Marker commit `[risk:medium]` (touche billing + nouvelle route HMAC entrante)
- DEPLOY_ENV (jamais NODE_ENV)
- Tests Nuclear obligatoires
- Stop sur staging — agent Hub promote main après validation E2E
- Coordination forte avec l'agent Prospection sur le contrat HMAC (shape
  exact filters_json, codes erreur, version bump)

## 7. Estimation

~4h dev (route + dispatcher + tests + doc).
