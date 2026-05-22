# [HUB] Runbook support — incidents paiement / plan utilisateur

> **Sévérité** : 🟡 P2 — opérationnel, à livrer avant montée en charge clients
> **Owner** : agent Hub
> **Créé** : 2026-05-23
> **Demandeur** : Robert — corollaire de la robustesse paiement
> **Refs** : `2026-05-23-e2e-billing-payment-lifecycle-complet.md`,
>   `2026-05-23-audit-trial-residus-apres-paiement.md`

---

## Pourquoi ce ticket

Les E2E garantissent que le code marche dans le cas normal. Le runbook
garantit qu'on sait **quoi faire quand quelque chose dérape avec un vrai
client**. Sans ça, à la première anomalie réelle, perte de temps en
investigation à l'aveugle.

---

## Runbooks à livrer

À écrire dans `docs/RUNBOOKS/billing/` :

### 1. "Le client dit qu'il a payé mais sa limite est toujours là"

Checklist d'investigation, par ordre :
1. Stripe Dashboard : la subscription existe-t-elle ? statut ?
2. `hub_app.stripe_events` : event `customer.subscription.created`
   correspondant reçu ? error column ?
3. `hub_app.users` : `stripeCustomerId` matche le customer Stripe ?
4. `hub_app.tenants` : `veridianPlan` reflète le plan attendu ?
5. App downstream (Notifuse/Prospection) : `veridian_plan` table reçue ?
   `last_hub_sync_at` récent ?
6. UI : cache navigateur — Ctrl+Shift+R ? cookie session expiré ?

Pour chaque étape : commande SQL/curl à exécuter (avec exemples), et
décision : où chercher la suite.

### 2. "Un webhook Stripe a échoué — que faire ?"

Cas observés :
- signature invalide → STRIPE_WEBHOOK_SECRET_LIVE rotation requise (procédure)
- customer introuvable → user signup pas terminé / stripeCustomerId mal sync
- price hors catalogue → ajouter à LEGACY_STRIPE_PRICE_MAPPING (cf ticket
  P2 2026-05-23-legacy-stripe-price-mapping.md)
- downstream app HS → vérifier health Notifuse/Prospection, le Hub réessaye
  selon retry Stripe (3j)

Pour chacun : symptômes dans les logs, commande de diagnostic, fix.

### 3. "Comment forcer la sync d'un client (override manuel)"

Procédure d'urgence :
- `POST /api/admin/tenants/[id]/plan` (API admin existante, livré sprint v1.4)
  body `{plan: 'pro', plan_source: 'grant_manual'}` → immune au webhook
- Quand l'utiliser : client paie, on voit la sub Stripe valide, mais
  l'automation a planté et le client appelle ; on débridé manuellement
  pendant qu'on debug.
- Quand NE PAS l'utiliser : si la sub Stripe n'existe pas (pas de cadeau
  involontaire) ; vérifier toujours côté Stripe Dashboard avant.

### 4. "Comment annuler proprement un client"

- via Stripe Customer Portal (le client s'auto-cancel) — flow normal
- via API admin si client appelle support :
  procédure exacte, ordre des actions, vérif que downgrade se propage

### 5. "Client en past_due — quand contacter, comment escalader"

- Stripe retry charge ~3 fois (config Dashboard)
- Hub reçoit `invoice.payment_failed` à chaque tentative
- Telegram alerte Robert (suppose ticket P1 Telegram livré)
- email user envoyé via Notifuse template dunning
- après N échecs → `customer.subscription.deleted` → downgrade auto
- procédure : à quel moment appeler le client, quoi proposer (changement CB,
  pause abonnement Stripe, refund partiel, etc.)

---

## Dimension formation

Ces runbooks sont aussi du matériel de formation si Robert prend un
support à terme. À écrire en français, avec exemples copyable, pas en
sec-jargon dense.

---

## DoD

- [ ] 5 runbooks livrés dans `docs/RUNBOOKS/billing/`
- [ ] Chaque runbook a : symptômes, commandes de diagnostic copyables,
      arbre de décision, fix step-by-step
- [ ] Référencé depuis `docs/CONTRAT-BILLING.md` (section "incidents")
- [ ] Testé : un agent qui ne connaît pas le contexte peut suivre un
      runbook et résoudre un cas réel sans aide
