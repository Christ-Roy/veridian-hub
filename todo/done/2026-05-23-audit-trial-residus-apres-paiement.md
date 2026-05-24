# [HUB] Audit — aucun résidu trial/limite après paiement (cross-app)

> **Sévérité** : 🟡 P1 — garantir la promesse "client paie = plus aucune limite"
> **Owner** : agent Hub (audit) + agents Notifuse/Prospection (corrections downstream)
> **Créé** : 2026-05-23
> **Demandeur** : Robert — "qu'il n'as plus de limite de temps"

---

## Pourquoi ce ticket

Un client qui paie doit voir **toute trace de trial / limite disparaître**, immédiatement et partout. Aujourd'hui, le code Hub gère la transition trial→paid mais il n'y a **pas d'audit cross-app systématique** que :
- les apps downstream (Notifuse, Prospection) purgent leurs propres compteurs/timers
- l'UI n'affiche plus aucun compte à rebours / bandeau "essai" sur aucune page
- aucune notification trial ne part après la conversion (mail "essai bientôt fini")
- aucun cron downstream ne continue à compter

Cf `docs/PRICING-VERIDIAN.md` : "L'app ne doit JAMAIS être défigurée par des limites visibles" — vrai en plan free, EXTRA-vrai en plan payant.

---

## Audit à mener

### A. Côté Hub

#### A.1 `tenant_trials` après conversion
- État cible : `state = 'converted'`, plus `'trial_active'` ou `'ending_soon'`
- Vérifier : `lib/trial/run-tick.ts` skip-il bien `state=converted` ?
- Vérifier : `lib/trial/banner-state.ts` retourne bien `null` pour `converted` (déjà mappé, confirmer)
- Test : créer un user trial_active, simuler webhook conversion, vérifier
  banner-state → null + run-tick → skip

#### A.2 FreemiumBanner et autres composants UI
- Grep tout `app/dashboard/**/*.tsx` `components/**/*.tsx` : tout ce qui mentionne
  `trial`, `essai`, `freemium`, `days remaining`, `expire`, `expiration`
- Pour chaque hit : vérifier que le rendu est **gaté sur la phase trial** (et
  pas juste sur `userCreatedAt` ou `hasActiveSubscription`)
- Note : `FreemiumBanner` est OK depuis 37810f4 (state machine) — vérifier
  qu'il n'y a pas d'AUTRE composant qui boucle sur des dates

#### A.3 Notifications email — Notifuse
- Templates trial : `welcome`, `first_email_sent`, `day_2`, `day_15`,
  `expiring_soon`, etc.
- Le cron qui envoie ces mails doit skipper les users `state=converted`
- Tester : forcer un user trial → conversion → vérifier qu'AUCUN mail trial
  ne part dans les 24h qui suivent (boîte de réception inspectable)

### B. Côté Notifuse (downstream)

#### B.1 `veridian_plan` table
- À la réception de `update-plan plan=pro plan_source=stripe` :
  - `veridian_plan` row : `plan='pro'`, `activity_threshold_reached_at` reset ou ignoré
  - Aucun timer/quota lié au trial ne doit "tourner" en background

#### B.2 Paywall & soft-delete inverse
- Si l'user était en mode dégradé soft-deleted (paywall lecture seule), le
  paiement doit **lever** ce mode :
  - `tenant_soft_deleted_at` set à null
  - middleware paywall détecte le changement → mode normal repris au
    prochain hit (sans purge cache forcée nécessaire mais à vérifier)

#### B.3 UI Notifuse
- Grep templates et composants : aucun message "trial expire dans X" ne doit
  s'afficher à un user `veridian_plan=pro`
- Le bandeau "essai gratuit" du dashboard Notifuse doit disparaître

### C. Côté Prospection (downstream)

#### C.1 `veridian_plan` + welcome leads
- Idem Notifuse : `plan=pro` reçu → tenant débridé
- **Spécifique Prospection** : à la conversion, créditer les welcome_leads du
  plan (2000 pour Pro, 8000 pour Business) — cf
  `2026-05-22-call-credit-leads-welcome-at-provisioning.md`
- L'audit doit vérifier que ce crédit est bien appliqué AU PASSAGE trial→paid,
  pas seulement au signup initial (le welcome est censé être one-shot par
  tenant, à clarifier)

#### C.2 Limite quotidienne / hebdo prospects
- Le freemium Prospection limite à 100 prospects "welcome pack permanent"
- Au passage paid : aucun cap visible, et le compteur d'usage doit refléter
  "illimité" — pas "98/100" qui s'arrête
- Audit du middleware Prospection qui applique les caps : doit lire le plan
  COURANT, pas un cache stale d'avant conversion

### D. Garde-fou général : drift detection

Cron (cf §4.3 du ticket
`2026-05-23-e2e-billing-payment-lifecycle-complet.md`) qui compare
quotidiennement :
- `tenant.veridianPlan` vs Stripe subscription status réel
- `tenant_trials.state` vs `tenant.veridianPlan` (incohérent si plan=pro
  et state=trial_active simultanément)
- alerte Telegram si drift détecté

---

## Livrables

1. **Rapport d'audit** par app (Hub, Notifuse, Prospection) listant pour
   chacune les composants/code paths qui touchent au trial, et l'état réel
   du comportement post-conversion.
2. **Tests E2E** pour les 4-5 cas qui matter le plus (à intégrer dans le
   ticket `2026-05-23-e2e-billing-payment-lifecycle-complet.md` §1).
3. **Tickets de correction** dans les repos downstream pour chaque gap réel
   trouvé.
4. **Runbook support** : "client a payé mais voit toujours sa limite — étapes
   d'investigation" (vérifier `stripe_events`, `tenant.veridianPlan`,
   `tenant_trials.state`, downstream cache TTL, etc.).

---

## DoD

- [ ] Audit Hub livré, gaps identifiés (s'il y en a)
- [ ] Tickets cross-app déposés pour gaps downstream
- [ ] Runbook support écrit dans `docs/RUNBOOKS/`
- [ ] 1 cron drift detection actif avec alerting
