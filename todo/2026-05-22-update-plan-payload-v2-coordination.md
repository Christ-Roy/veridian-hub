# [HUB] Migrer le payload `update-plan` Hub→apps vers v2 — coordination cross-app

> **Sévérité** : 🟡 P1 — dette de conformité contractuelle, non bloquante en prod
> **Owner** : agent Hub
> **Créé** : 2026-05-22 (sprint billing Stripe)
> **Réfère** : `docs/CONTRAT-BILLING.md` v2.0 §3, `lib/notifuse/client.ts`,
>   `utils/stripe/prisma-sync.ts`

---

## Contexte

Le sprint billing Stripe (ticket `2026-05-21-pricing-sync-stripe-products.md`)
a branché le checkout + dispatcher. Le BLOC 3 demandait un dispatcher conforme
`CONTRAT-BILLING.md` v2.0.

Le dispatcher est conforme **pour le mapping price→plan→apps** (bundle = 2
apps, idempotence event.id, downgrade auto, dunning Hub-side). En revanche le
**payload `update-plan` envoyé sur le wire à Notifuse** est encore v1 :

```jsonc
// Actuel — NotifuseClient.updatePlan (lib/notifuse/client.ts)
{ "tenant_id": "...", "plan": "..." }
```

Le contrat v2.0 §3.2 fige un payload enrichi :

```jsonc
{
  "contract_version": "2.0",
  "tenant_id": "...",
  "plan": "free|pro|business|enterprise",
  "plan_source": "stripe|stripe_trial|grant_manual|downgrade_auto",
  "effective_at": "ISO8601",
  "stripe_subscription_id": "string|null",
  "idempotency_key": "uuid",
  "reason": "string"
}
```

## Pourquoi ça n'a PAS été fait dans le sprint billing

Passer le Hub en payload v2 **maintenant casserait la propagation en prod** :
la matrice de conformité `CONTRAT-BILLING.md` §9 indique que Notifuse et
Prospection sont encore `⏳ ticket conformité` pour :
- « Lit `contract_version`, rejette `400` si major inconnu »
- « Gère les 4 `plan_source` »
- « Idempotence sur `idempotency_key` »

Les apps ont chacune le ticket `2026-05-22-aligner-contrat-billing-v2.md`
**non encore livré** dans leur `todo/`. Tant qu'elles ne savent pas lire le
v2, le Hub doit rester en v1 sur le wire — c'est une migration coordonnée
cross-repo, pas un changement unilatéral Hub.

## Ce qu'il faut faire (quand les apps sont prêtes)

1. Attendre la livraison des tickets `aligner-contrat-billing-v2.md` côté
   Notifuse + Prospection (apps sachant parser le payload v2).
2. Étendre `UpdatePlanInput` + `NotifuseClient.updatePlan` (et l'équivalent
   Prospection quand son endpoint `update-plan` HMAC sera câblé) pour émettre
   le payload v2 complet.
3. Brancher le `plan_source` correct depuis le dispatcher :
   `stripe` (sub active payante), `downgrade_auto` (sub annulée/expirée),
   `grant_manual` (admin), `stripe_trial` (trial state machine).
4. Générer un `idempotency_key` déterministe par (event.id, app) pour que le
   replay Stripe ne double-applique pas.
5. Mettre à jour la matrice §9 de `CONTRAT-BILLING.md` (lignes ⏳ → ✅).

## Impact si non fait

Aucun en prod aujourd'hui — le v1 fonctionne, la propagation marche. C'est
une dette de **conformité contractuelle** : le contrat v2.0 est gravé mais le
wire n'y est pas encore. À résorber quand les apps downstream sont alignées.
