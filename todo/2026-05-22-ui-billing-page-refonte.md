# UI — Refonte page billing (état subscription + dunning + checkout)

> **Sévérité** : 🟡 P1 — la page billing est un état de stub face au webhook orchestrator livré
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : commit Stripe webhook orchestrator 53b6c72 (`todo/done/2026-05-21-stripe-webhook-orchestrator.md`), `docs/PRICING-VERIDIAN.md`

## Contexte

Le Stripe webhook orchestrator a été livré (53b6c72) : le Hub reçoit et
synchronise tous les états de subscription (`trialing`, `active`, `past_due`,
`canceled`, dunning). La page `app/dashboard/billing/page.tsx` n'a pas suivi —
elle affiche un strict minimum et ne tire aucune valeur de l'orchestrator.

État actuel (`app/dashboard/billing/page.tsx`) :

- Affiche prix + status badge + quelques dates, puis un bouton "Manage
  Subscription" (Stripe Portal). C'est tout.
- **`past_due` n'a aucun traitement UX visible** : un user en échec de
  paiement voit juste un petit badge "Past Due" orange. Aucune alerte, aucun
  CTA "Mets à jour ta carte", aucune explication du dunning. C'est la pire
  régression : un client en train de churner par défaut de paiement n'est pas
  rattrapé.
- **Pas de "plan actuel" lisible** : le hero dit juste "You are currently on
  the X plan" en texte. Pas de carte plan mise en avant.
- **`canceled`** : un user annulé voit "Canceled" + la date — mais aucun CTA
  "Réactiver" alors que le doc trial parle explicitement d'un lien Réactiver.
- **Pas de checkout inline** : si pas de subscription, on a juste un lien texte
  "View pricing plans" → `/pricing`. Pas de comparatif, pas de CTA upgrade
  contextualisé.
- Bloc "Debug Information" affiché en `NODE_ENV=development` — OK en dev, mais à
  surveiller (cf. le commentaire de l'audit précédent : vérifier qu'il ne fuit
  pas en build prod).
- Toute la page est en anglais (cf. ticket `2026-05-22-ui-i18n-francais-dashboard.md`).

## Travail à faire

1. **Traiter visiblement l'état `past_due` / dunning** : quand la subscription
   est `past_due`, afficher une `<Alert variant="warning">` ou `destructive` en
   haut de page : "Le dernier paiement a échoué. Mets à jour ta carte pour
   éviter la suspension." + CTA direct vers le Stripe Portal (méthode de
   paiement). C'est le point le plus important du ticket.
2. **État `canceled`** : afficher un CTA "Réactiver mon abonnement" (cohérent
   avec le lien "Réactiver" du flow trial dans `docs/PRICING-VERIDIAN.md`).
   Préciser jusqu'à quand l'accès reste ouvert (`currentPeriodEnd`).
3. **État `trialing`** : afficher clairement "Essai en cours" + date de fin,
   ton positif, sans deadline anxiogène (cohérence avec le ticket bandeau trial
   `2026-05-22-ui-trial-banner-state-machine.md`).
4. **Pas de subscription** : remplacer le lien texte "View pricing plans" par un
   vrai bloc — soit les plans inline, soit un `<Button>` clair vers `/pricing`,
   avec une phrase d'accroche. État vide propre, pas un orphelin.
5. **Hero "plan actuel"** : carte mise en avant avec le nom du plan, le prix
   (déjà en EUR `fr-FR` — OK), le statut.
6. Passer la page en français (couvert aussi par le ticket i18n — coordonner).
7. Optionnel si le temps : toggle mensuel/annuel sur la page billing (cf. Sprint
   D de l'audit précédent) — non bloquant, peut rester un sous-point.

## Fichiers concernés

- `app/dashboard/billing/page.tsx`
- `app/dashboard/billing/StripePortalButton.tsx` (vérifier qu'il accepte un
  paramètre pour ouvrir directement la section "méthode de paiement" du portal)
- `components/ui/alert.tsx` (variants `warning`/`destructive` déjà dispos)

## DoD

- [ ] Un user `past_due` voit une alerte claire + CTA mise à jour CB
- [ ] Un user `canceled` voit un CTA "Réactiver" + date de fin d'accès
- [ ] Un user sans subscription voit un état vide actionnable (pas un lien texte nu)
- [ ] La page est en français
- [ ] Test : rendu correct pour chaque statut (`trialing`/`active`/`past_due`/`canceled`)
