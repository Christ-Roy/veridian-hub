# [HUB] Perks plans annuels — onboarding accompagné + support prioritaire

> **Sévérité** : 🔵 P5 — différé. À remonter quand le checkout Stripe tourne
>   et qu'on a des premiers clients annuels réels.
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Décision Robert** : sorti du sprint Stripe `pricing-sync-stripe-products.md`
>   pour livrer le checkout vite. Les perks viennent après.

---

## Contexte

`docs/PRICING-VERIDIAN.md` v1.1 prévoit que les plans **annuels** incluent une
valeur ajoutée : support prioritaire, onboarding accompagné (visio 30-60min),
accès tutos avancés. Le sprint Stripe ne câble QUE le paiement (mensuel +
annuel encaissés) — les automations de perks sont ce ticket.

## À livrer (quand réactivé)

1. **Choix stack calendar** : Cal.com (self-host, gratuit) vs Calendly (SaaS).
   Décision Robert à ce moment-là.
2. **`lib/annual-perks/triggerAnnualPerks.ts`** : déclenché par le webhook
   `customer.subscription.created` quand `Price.metadata.interval=year` :
   - tag user `metadata.veridian_annual=true`
   - email de bienvenue annuel (lien calendar + tutos)
   - notif Telegram Robert ("nouveau client annuel")
   - `audit_log` entry `annual_perks.triggered`
3. **Type `Plan.annualPerks`** dans `shared/pricing/plans.ts`.
4. **Template MJML `veridian-annual-welcome`** (skill `notifuse-templates`).
5. **ENV** : `ANNUAL_CALENDAR_LINK`, `ANNUAL_SUPPORT_CHANNEL`.
6. **Décision** : stack support prioritaire (Lark group / email helpdesk@).

## Pré-requis

- Le sprint `pricing-sync-stripe-products.md` doit être livré (checkout +
  dispatcher en prod) — les perks se greffent sur le webhook qui existera.

## Trigger de réactivation

Remonter ce ticket en P1/P2 dès qu'il y a des clients annuels réels OU que
Robert veut activer la promesse "annuel = accompagnement".
