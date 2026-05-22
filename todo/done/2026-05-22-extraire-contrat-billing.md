# [HUB] Extraire un CONTRAT-BILLING.md dédié aux apps commerciales

> **Type** : Refactor doc contractuelle + graver le billing cross-app
> **Sévérité** : 🔴 P1 — PRÉ-REQUIS du giga sprint pricing/billing. À livrer
>   AVANT `pricing-sync-stripe-products` sinon l'agent qui code le checkout
>   invente le payload `update-plan` et il faut le corriger cross-app après
>   coup (bug type `HUB_INVITATION_SECRET_*` de la session 2026-05-21, mais
>   pire car ça touche l'argent).
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Demandeur** : Robert
> **Sources de vérité existantes** : `docs/CONTRAT-HUB.md` (~2700L, monolithe),
>   `docs/PRICING-VERIDIAN.md` v1.1, `docs/CONTRAT-HUB-API-REF.md`

---

## 0. CONTEXTE — lis ça en premier

Le `CONTRAT-HUB.md` actuel est un monolithe de ~2700 lignes qui mélange
TOUT : auth, identité user, pricing, lifecycle tenant, endpoints, multi-membre,
i18n, webhooks. Devenu dur à naviguer et à faire évoluer.

**Décision Robert (2026-05-22)** : on découpe le contrat par préoccupation.
Mais **pas tout d'un coup** — on commence par **extraire la partie BILLING**
parce que c'est ce qui bloque le giga sprint pricing.

Découpage cible (à terme, pas dans ce ticket) :
- `CONTRAT-AUTH.md` — auth cross-app (OAuth, sessions, magic links, identité
  user, hub_user_id bridge). **Plus tard.**
- `CONTRAT-BILLING.md` — **CE TICKET** — pricing + Stripe + lifecycle billing,
  scopé aux apps commerciales.
- `CONTRAT-HUB.md` — reste (provisioning, webhooks génériques, sync tenants,
  endpoints lifecycle non-billing). Reste le doc "cross-app large". Sera
  re-découpé plus tard si besoin.

**Ce ticket = extraire BILLING uniquement.** Auth et le reste restent dans
`CONTRAT-HUB.md` pour l'instant.

---

## 1. PÉRIMÈTRE — apps commerciales SEULEMENT

`CONTRAT-BILLING.md` s'applique **explicitement et uniquement** aux apps
SaaS commerciales self-serve :

- ✅ **Notifuse** — app SaaS payante, plans Free/Pro/Business/Enterprise
- ✅ **Prospection** — app SaaS payante, plans Freemium/Pro/Business + refill leads

Et **PAS** aux apps "client / shadow marketing" :

- ❌ **CMS** — outil pour les sites clients de Robert, pas de billing Stripe
  end-user (Robert facture ses clients hors plateforme)
- ❌ **Analytics** — idem, pas en SaaS public payant

Le contrat BILLING **liste cette distinction noir sur blanc** en tête de doc
(cf §3.6 du contrat actuel "apps self-serve vs apps shadow marketing" —
relier, c'est la même distinction). Liste figée : si une app change de statut
(ex: Analytics passe SaaS public un jour), on amende explicitement la liste.

---

## 2. DÉCISION ARCHITECTURALE À GRAVER — ne pas remettre en cause

Robert a évoqué l'idée que "les apps puissent avoir des webhooks Stripe en
plus du Hub" pour de la redondance. **REJETÉ — et le contrat BILLING doit
écrire pourquoi, pour que personne ne re-propose :**

> **UN SEUL endpoint Stripe dans tout Veridian : `POST /api/webhooks` côté
> Hub. Les apps ne reçoivent JAMAIS de webhook Stripe directement et
> n'appellent JAMAIS l'API Stripe en écriture.**

Pourquoi (à graver dans le doc) :
1. **Une seule source de vérité du mapping `stripe_customer_id ↔ tenant`.**
   2 listeners = 2 mappings qui divergent = debug fantôme cross-repo.
2. **Un seul `STRIPE_WEBHOOK_SECRET` à sécuriser/roter** au lieu de 4.
3. **MRR agrégé cross-app** impossible si chaque app voit sa part séparément.
4. **La résilience NE se gagne PAS en dupliquant les listeners.** Elle est
   déjà acquise par : (a) Stripe retry un webhook ~3 jours tant qu'il n'a
   pas un 200 → Hub down 1h = 0 event perdu ; (b) le Hub persiste l'event
   dans `stripe_events` AVANT dispatch, idempotence sur `event.id` PK.
   Résilience = idempotence + retry Stripe, PAS duplication.

---

## 3. CONTENU du CONTRAT-BILLING.md — les 8 parties à graver

### 3.1 Périmètre & philosophie
- Liste des apps commerciales concernées (cf §1)
- Lien vers `PRICING-VERIDIAN.md` v1.1 (source de vérité métier : grille
  prix, philosophie générosité maximale). Le contrat BILLING = source de
  vérité TECHNIQUE, PRICING-VERIDIAN = source de vérité MÉTIER. Cohérents.

### 3.2 Frontière Stripe unidirectionnelle (cf §2 ci-dessus)
```
Stripe ──webhook──► Hub /api/webhooks ──HMAC──► App /api/tenants/update-plan
```
Tableau "qui fait quoi" : Stripe=paiement | Hub=orchestration + seul
interlocuteur Stripe | App=consomme update-plan + applique paywall local.

### 3.3 Payload `update-plan` — versionné et figé
Le payload Hub → `<app>/api/tenants/update-plan`. Schéma exact à graver :
```jsonc
{
  "contract_version": "2.0",
  "tenant_id": "string",
  "plan": "free|pro|business|enterprise",   // enum FERMÉ, cf PRICING-VERIDIAN
  "plan_source": "stripe|stripe_trial|grant_manual|downgrade_auto",
  "effective_at": "ISO8601",
  "stripe_subscription_id": "string|null",  // null si plan offert
  "idempotency_key": "uuid",
  "reason": "string"
}
```
Invariants :
- App rejette 400 si `contract_version` major inconnu (pas de best-effort)
- App rejette 400 si `plan` hors enum
- App idempotente sur `idempotency_key` (relier §5.11 du contrat)
- Plan offert immune : tenant `plan_source=grant_manual` ne se fait pas
  downgrade par un `update-plan plan_source=stripe` (relier §3.3 contrat)

### 3.4 Fail-open — comportement App si Hub DOWN
> **Une app ne dégrade/paywalle/bloque JAMAIS un user parce qu'elle n'a pas
> reçu un signal du Hub. En cas de doute → dernier état connu. Fail-open.**

- Hub down → app garde le tenant dans son plan actuel jusqu'au prochain
  update-plan. Pas de downgrade par timeout.
- App sans update-plan jamais reçu → défaut `free`.
- Anti-pattern INTERDIT : cron app "si pas de heartbeat Hub depuis X,
  downgrade tout".

### 3.5 Dunning (`invoice.payment_failed`)
- Hub reçoit `invoice.payment_failed`, gère le cycle dunning (Stripe retry
  N fois selon config Dashboard). Tenant reste actif pendant la fenêtre de
  grâce (CB expirée ≠ client perdu).
- Stripe abandonne → `customer.subscription.deleted` → Hub dispatch
  `update-plan plan=free plan_source=downgrade_auto` → app applique son mode
  dégradé paywall (§5.9 contrat).
- **Le dunning n'est pas géré par les apps.** Elles voient le update-plan final.

### 3.6 Réconciliation — rattraper un event manqué
Cas extrême : Hub down > 3 jours (au-delà du retry Stripe). Graver l'endpoint :
```
GET /api/tenants/{tenant_id}/billing-state   (HMAC app→Hub)
→ { plan, plan_source, stripe_subscription_id, effective_at, updated_at }
```
- App peut poller (cron lent, ex 1×/jour, hors hot path) pour se resync.
- Reco : poll plutôt qu'ACK explicite (plus simple, pas d'état d'ACK à tenir).
- ⚠️ Décision à confirmer Robert : poll vs ACK — poser 2-3 options, ne pas
  trancher seul.

### 3.7 Trial — articulation state machine
La trial state machine Hub est livrée (sprint v1.4, `lib/trial/run-tick.ts`).
- Trial génère `update-plan plan=pro plan_source=stripe_trial`.
- `stripe_trial` ≠ `stripe` : l'app DOIT distinguer (UI "essai" vs "abonné",
  pas de facture sur un trial).
- Le signal `activity_threshold_reached` vient de l'app VERS le Hub — c'est
  le SEUL flux billing app→Hub. Le graver comme exception explicite.

### 3.8 Stripe Customer = 1 humain, multi-app
- 1 `stripe_customer_id` = 1 user Hub = 1 humain.
- N subscriptions possibles sous le même customer (Notifuse Pro + bundle).
- `metadata.app` de chaque Subscription identifie l'app cible. Bundle =
  `metadata.app=bundle` → dispatch vers 2+ apps.
- Relier au ticket `pricing-sync-stripe-products` §2 (convention metadata).

---

## 4. FORME du livrable

1. **Nouveau fichier** `docs/CONTRAT-BILLING.md` — la partie billing extraite.
2. **`docs/CONTRAT-HUB.md`** : retirer les sections billing migrées (§7.4
   chaîne Stripe, parties billing de §3, §5.2 update-plan détaillé) et les
   remplacer par un **pointeur court** : "Le billing cross-app est spec'd
   dans `CONTRAT-BILLING.md` — ce contrat ne couvre que le non-billing."
   ⚠️ Ne PAS casser les ancres référencées ailleurs — vérifier les liens.
3. **`docs/CONTRAT-HUB-API-REF.md`** : déplacer les endpoints billing dans
   une section dédiée OU créer `CONTRAT-BILLING-API-REF.md`. À l'agent de
   choisir le plus propre, mais cohérent avec le découpage.
4. **Symlink racine** : créer `veridian-platform/CONTRAT-BILLING.md` →
   `veridian-hub/docs/CONTRAT-BILLING.md` (même pattern que les autres
   symlinks racine).
5. Bump version : `CONTRAT-BILLING.md` démarre en **v2.0** (jalon billing
   gravé). `CONTRAT-HUB.md` reste sur sa lignée mais note dans son changelog
   "billing extrait vers CONTRAT-BILLING.md v2.0".

---

## 5. COORDINATION cross-app

Une fois `CONTRAT-BILLING.md` figé :
- Ticket dans `notifuse-veridian/todo/` : "aligner update-plan consumer sur
  CONTRAT-BILLING v2 (versioning + fail-open + plan_source enum)".
- Idem `veridian-prospection/todo/`.
- PAS de ticket CMS/Analytics (hors périmètre billing).
- Prévenir Robert pour router vers les agents apps.

---

## 6. ORDRE vs le giga sprint

**Ce ticket DOIT être livré AVANT** :
- `2026-05-21-pricing-sync-stripe-products.md` (agent checkout a besoin du
  payload update-plan figé + des conventions)
- Tout ticket touchant le dispatcher Stripe / flow billing

**Ne bloque PAS** : les tickets non-billing du backlog (UI, OAuth, discovery,
tenant-sync, etc.) — le giga sprint peut paralléliser ceux-là pendant que
le contrat BILLING se rédige.

---

## 7. ESTIMATION

Surtout réflexion + écriture + déplacement de sections. ~1 session focalisée
(3-5h agent). Le code de réf existe déjà (dispatcher Stripe, update-plan,
trial state machine en prod) — ce ticket les GRAVE et RÉORGANISE, ne recode
rien. Seul code neuf possible : endpoint `GET /api/tenants/{id}/billing-state`
(§3.6) si on retient le poll.

---

## 8. DÉFINITION OF DONE

- [ ] `docs/CONTRAT-BILLING.md` créé, v2.0, couvre les 8 parties §3
- [ ] Liste apps commerciales (Notifuse + Prospection) gravée + exclusion
      explicite CMS/Analytics
- [ ] Frontière "1 seul endpoint Stripe, jamais multi-apps" écrite avec sa
      justification (§2) — pour que personne ne re-propose
- [ ] Payload `update-plan` v2 versionné + spec'd dans l'API-REF
- [ ] Endpoint `GET /api/tenants/{id}/billing-state` spec'd (§3.6)
- [ ] Sections billing retirées de `CONTRAT-HUB.md` + pointeur ajouté, ancres
      non cassées
- [ ] Symlink racine `veridian-platform/CONTRAT-BILLING.md` créé
- [ ] Changelogs des 2 contrats mis à jour
- [ ] Tickets de mise en conformité déposés notifuse + prospection
- [ ] Robert prévenu pour router les tickets cross-app

---

## 9. GARDE-FOUS pour l'agent qui prend ce ticket

- **Tu EXTRAIS et GRAVES, tu ne recodes pas.** Le dispatcher Stripe,
  update-plan, la trial state machine sont en prod. Ton job = doc.
- **Tu ne casses pas les ancres** : `CONTRAT-HUB.md` est référencé par
  d'autres docs/tickets/memories. Avant de retirer une section, grep son
  ancre dans tout le repo + les autres repos.
- **Tu ne tranches pas seul les décisions archi** : poll vs ACK pour la
  réconciliation (§3.6) → poser les options à Robert.
- **Cohérence métier** : `CONTRAT-BILLING.md` (technique) doit être cohérent
  avec `PRICING-VERIDIAN.md` v1.1 (métier). Si tu vois une contradiction,
  raise-la, ne l'écris pas en silence.
- **Périmètre strict** : tu extrais le BILLING. PAS l'auth, PAS le reste.
  L'auth sera un ticket séparé plus tard. Ne pars pas dans un refactor total
  du contrat — Robert a explicitement dit "BILLING d'abord, le reste après".
