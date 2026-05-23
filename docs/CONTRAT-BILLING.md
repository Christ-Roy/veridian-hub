# CONTRAT-BILLING.md — Contrat billing cross-app Veridian

> **Version** : v2.0 (2026-05-22) — jalon billing extrait du monolithe
> `CONTRAT-HUB.md`. Le `v2.0` marque le découpage : ce contrat démarre
> directement à 2.0 pour aligner son numéro sur le `contract_version` du
> payload `update-plan` (cf §3.3).
> **Statut** : figé par Robert (2026-05-22).
> **Scope** : pricing technique + Stripe + lifecycle billing, **scopé aux
> apps commerciales self-serve** (cf §1).
> **Audience** : agents Claude (Hub + apps commerciales), reviewers, Robert.
>
> **Compagnons** :
> - `PRICING-VERIDIAN.md` — source de vérité **métier** (grille de prix,
>   philosophie générosité maximale, flow trial business). Ce contrat-ci
>   est la source de vérité **technique** : les deux DOIVENT rester
>   cohérents. Toute contradiction se raise avant d'agir.
> - `CONTRAT-HUB.md` — contrat technique d'intégration cross-app
>   **non-billing** (provisioning, lifecycle tenant, identité user,
>   webhooks génériques, multi-membre, permissions).
> - `CONTRAT-HUB-API-REF.md` — référence API exhaustive (les endpoints
>   billing y vivent dans la section "Billing & Pricing" + "Stripe webhook
>   orchestrator").
>
> 🔥 **Règle absolue** : tout agent qui touche au pricing, paywall, trial,
> webhooks Stripe, dispatch de plan, lifecycle billing DOIT lire ce
> contrat avant d'agir. Si une app implémente quelque chose qui le
> contredit, l'agent raise la contradiction — il ne code pas le contournement.

---

## Table des matières

1. [Périmètre & philosophie](#1-périmètre--philosophie)
2. [Frontière Stripe unidirectionnelle — UN seul endpoint](#2-frontière-stripe-unidirectionnelle--un-seul-endpoint)
3. [Payload `update-plan` v2 — versionné et figé](#3-payload-update-plan-v2--versionné-et-figé)
4. [Fail-open — comportement App si Hub down](#4-fail-open--comportement-app-si-hub-down)
5. [Dunning — `invoice.payment_failed`](#5-dunning--invoicepayment_failed)
6. [Réconciliation — rattraper un event manqué (POLL)](#6-réconciliation--rattraper-un-event-manqué-poll)
7. [Trial — articulation avec la state machine](#7-trial--articulation-avec-la-state-machine)
8. [Stripe Customer = 1 humain, multi-app](#8-stripe-customer--1-humain-multi-app)
9. [Matrice de conformité billing](#9-matrice-de-conformité-billing)
10. [Changements](#10-changements)

---

## 1. Périmètre & philosophie

### 1.1 Apps concernées — apps commerciales SEULEMENT

Ce contrat s'applique **explicitement et uniquement** aux apps SaaS
commerciales self-serve : celles où un humain s'inscrit, choisit un plan,
et paie via Stripe Checkout.

| App | Statut billing | Plans |
|---|---|---|
| ✅ **Notifuse** | App SaaS payante, self-serve | Free / Pro 29€ / Business 99€ / Enterprise |
| ✅ **Prospection** | App SaaS payante, self-serve | Freemium / Pro 29€ / Business 89€ + refill leads |

Et **PAS** aux apps "client / shadow marketing" :

| App | Pourquoi exclue |
|---|---|
| ❌ **CMS** | Outil pour les sites clients de Robert. Robert facture ses clients **hors plateforme** — pas de billing Stripe end-user. |
| ❌ **Analytics** | Idem CMS. Pas en SaaS public payant. Mode dormant. |

Cette distinction est la même que `CONTRAT-HUB.md` §3.6 "apps self-serve vs
apps shadow marketing" (`self_serve: true` vs `client_only: true` dans le
catalogue d'apps). Un agent CMS ou Analytics qui se demande s'il doit
implémenter quoi que ce soit de ce contrat : **non**, sauf indication
contraire explicite.

> **Liste figée par design.** Si une app change de statut un jour (ex :
> Analytics passe SaaS public payant), on **amende explicitement cette
> liste** + le changelog §10. Pas d'extension implicite.

### 1.2 Frontière métier vs technique

| Doc | Rôle |
|---|---|
| `PRICING-VERIDIAN.md` v1.1 | Source de vérité **métier** : grille de prix (Free / Pro 29€ / Business 99€ / Enterprise), philosophie "générosité maximale, conversion par le temps", flow trial business (5 mails → 2j → 15j → +30j si CB), interdits UX (pas de mur béton, pas de compteur visible). |
| `CONTRAT-BILLING.md` (ce doc) v2.0 | Source de vérité **technique** : qui parle à Stripe, quel payload circule, quels invariants, comment une app survit au Hub down, comment elle se resynchronise. |

Les deux sont **cohérents par construction**. Si tu détectes une
contradiction (ex : ce contrat dit `plan` enum fermé `{free,pro,business,
enterprise}` mais `PRICING-VERIDIAN.md` introduit un 5e plan), c'est un
**bug doc** : raise-le, ne l'écris pas en silence.

### 1.3 Philosophie billing reprise de PRICING-VERIDIAN

Trois principes héritent du doc métier et contraignent l'implémentation
technique :

1. **Générosité maximale.** Tout illimité partout. Les seules
   différenciations sont la durée Free (15j Notifuse) et le white-label
   (Business+). L'app ne doit jamais être défigurée par des limites
   visibles.
2. **Conversion par le temps, pas par l'agacement.** Le paywall se
   déclenche sur une **deadline** (trial expiré), jamais sur une feature
   bloquée. Techniquement : pas de `402` sur une feature individuelle, le
   mode dégradé est global et lié au lifecycle (cf §4, §5).
3. **Fail-open.** Le doute profite toujours à l'utilisateur. Une app ne
   dégrade jamais un tenant parce qu'elle manque d'un signal (cf §4).

---

## 2. Frontière Stripe unidirectionnelle — UN seul endpoint

### 2.1 La règle

```
Stripe ──webhook──► Hub /api/webhooks ──HMAC──► App /api/tenants/update-plan
```

> 🔒 **UN SEUL endpoint Stripe dans tout Veridian : `POST /api/webhooks`
> côté Hub. Les apps ne reçoivent JAMAIS de webhook Stripe directement et
> n'appellent JAMAIS l'API Stripe en écriture.**

| Acteur | Fait | Ne fait PAS |
|---|---|---|
| **Stripe** | Encaisse le paiement, émet les webhooks. | N/A |
| **Hub** | Reçoit **tous** les webhooks Stripe sur l'unique endpoint `POST /api/webhooks`. Mappe `stripe_customer_id ↔ tenant`. Dispatche `update-plan` HMAC aux apps. Seul interlocuteur Stripe (lecture + écriture). | Détecter l'activité métier d'une app. |
| **App commerciale** | Consomme `POST /api/tenants/update-plan` (HMAC Hub). Applique le paywall local. Émet `activity_threshold_reached` vers le Hub (seul flux billing app→Hub, cf §7). | Recevoir un webhook Stripe. Appeler l'API Stripe en écriture. Gérer le dunning. Tenir une state machine trial. |

### 2.2 Pourquoi UN SEUL endpoint — décision gravée, ne pas re-proposer

> Robert a évoqué l'idée que "les apps puissent avoir des webhooks Stripe
> en plus du Hub" pour de la redondance. **REJETÉ.** Cette section grave
> le pourquoi pour que personne ne re-propose une architecture multi-listeners.

1. **Une seule source de vérité du mapping `stripe_customer_id ↔ tenant`.**
   Deux listeners = deux mappings qui divergent dans le temps = debug
   fantôme cross-repo quand un tenant a un plan incohérent entre apps.

2. **Un seul `STRIPE_WEBHOOK_SECRET` à sécuriser et roter** au lieu de 4.
   Chaque endpoint Stripe est une surface d'attaque et un secret à gérer.

3. **MRR agrégé cross-app** impossible si chaque app ne voit que sa part
   du paiement séparément. Le Hub doit voir l'intégralité des subscriptions
   d'un Customer pour calculer le revenu réel (notamment les bundles, §8).

4. **La résilience NE se gagne PAS en dupliquant les listeners.** Elle est
   déjà acquise par :
   - **(a) Retry Stripe** — Stripe retry un webhook automatiquement jusqu'à
     ~3 jours tant qu'il n'obtient pas un `200`. Hub down 1h = 0 event perdu.
   - **(b) Idempotence Hub** — le Hub persiste l'event dans
     `hub_app.stripe_events` (PK = `event.id`) **avant** dispatch. Un event
     déjà processé (`processed_at IS NOT NULL`) renvoie `200 idempotent`
     sans re-dispatch.

   Résilience billing = **idempotence + retry Stripe**, PAS duplication de
   listeners. Le cas Hub down > 3 jours (au-delà du retry Stripe) est
   couvert par la réconciliation POLL §6.

### 2.3 Conséquence pour les apps commerciales

Une app commerciale **n'a aucune dépendance au SDK Stripe**. Elle ne
connaît ni `stripe_customer_id`, ni `stripe_subscription_id` au sens
"clé d'API Stripe" — elle reçoit `stripe_subscription_id` comme une
**chaîne opaque d'audit** dans le payload `update-plan` (§3.3), jamais
comme un handle pour appeler Stripe.

---

## 3. Payload `update-plan` v2 — versionné et figé

### 3.1 Direction et auth

- **Endpoint** : `POST <app>/api/tenants/update-plan`
- **Direction** : Hub → app commerciale.
- **Auth** : HMAC Hub (Pattern A — `CONTRAT-HUB.md` §6.1). Headers
  `x-veridian-timestamp` + signature, drift max 5 min.
- **Déclencheur** : un event Stripe traité par `POST /api/webhooks` (Hub),
  OU une transition de la trial state machine, OU une action admin Hub.
- **Idempotent** : oui — re-apply du même `idempotency_key` = no-op + `200`.

### 3.2 Schéma exact du body — v2

```jsonc
{
  "contract_version": "2.0",
  "tenant_id": "string",
  "plan": "free|pro|business|enterprise",   // enum FERMÉ, cf PRICING-VERIDIAN
  "plan_source": "stripe|stripe_trial|grant_manual|downgrade_auto",
  "effective_at": "ISO8601",
  "stripe_subscription_id": "string|null",  // null si plan offert / trial
  "idempotency_key": "uuid",
  "reason": "string"
}
```

| Champ | Type | Sens |
|---|---|---|
| `contract_version` | string | Version du contrat billing. `"2.0"` aujourd'hui. L'app **rejette `400`** si le **major** est inconnu (cf §3.4). |
| `tenant_id` | string | ID du tenant côté Hub (UUID) ou slug app selon ce que l'app a stocké au provisioning. |
| `plan` | enum | **Enum fermé** : `free`, `pro`, `business`, `enterprise`. Enum **canonique cross-app** (cf §3.2bis pour le mapping vers les noms de plan locaux d'une app). L'app **rejette `400`** si hors enum. |
| `plan_source` | enum | Origine du changement de plan. Enum fermé, 4 valeurs (cf §3.3.1). |
| `effective_at` | ISO8601 | Date d'effet du plan. Permet à l'app de programmer un changement futur si besoin (en pratique = quasi `now`). |
| `stripe_subscription_id` | string\|null | ID de la subscription Stripe à l'origine du changement, **opaque** côté app (audit uniquement). `null` si `plan_source ∈ {grant_manual}` (plan offert sans Stripe) ou si `stripe_trial` sans CB. |
| `idempotency_key` | uuid | Clé de dédup. L'app **dédoublonne** dessus (cf §3.4). |
| `reason` | string | Trace d'audit humaine (ex : `"checkout.session.completed evt_1Nx..."`, `"trial activation"`, `"admin grant lifetime"`). |

### 3.2bis Mapping `plan` canonique ↔ nom de plan local

L'enum `plan` du payload (`free | pro | business | enterprise`) est **la
clé d'échange cross-app**. Il ne change jamais entre apps. En revanche,
une app PEUT afficher ses plans sous un autre nom dans **sa propre UI** :

| `plan` canonique (payload) | Nom local Notifuse | Nom local Prospection |
|---|---|---|
| `free` | Free | **Freemium** |
| `pro` | Pro | Pro |
| `business` | Business | Business |
| `enterprise` | Enterprise | — (pas de tier Enterprise Prospection) |

> **Prospection** : sa grille interne nomme le tier gratuit `freemium`.
> Sur le fil contractuel `update-plan`, le Hub envoie toujours **`free`**.
> Prospection fait le mapping `free → freemium` **côté elle** (adaptateur
> local), elle ne demande pas au Hub d'envoyer `freemium`.
>
> **Règle** : une app reçoit et renvoie l'enum canonique. Le nom local
> est un détail d'affichage qui ne franchit jamais l'API. Si une app
> reçoit `update-plan` avec `plan` hors enum canonique → `400` (§3.4.2),
> même si la valeur correspond à un de ses noms locaux.
>
> Si une app n'a pas de tier `enterprise` (cas Prospection), recevoir
> `update-plan plan=enterprise` est traité par l'app comme son plan le
> plus élevé (`business`) avec un log warn — pas un `400` : l'enum est
> valide, c'est juste que l'app n'a pas ce palier. À documenter côté app.

### 3.3 L'enum `plan_source` — 4 valeurs figées

| `plan_source` | Émis quand | Effet attendu côté app |
|---|---|---|
| `stripe` | Une subscription Stripe **payante active** existe (checkout complété, renouvellement). | Tenant abonné payant. UI "abonné". Factures réelles. |
| `stripe_trial` | La trial state machine a activé un trial Pro 15j (cf §7). Pas de CB / pas de débit encore. | Tenant en **essai gratuit**. UI "essai" (≠ "abonné"). **Aucune facture émise sur un trial.** |
| `grant_manual` | Un admin Hub assigne un plan offert (`lifetime_site_vitrine`, `lifetime_partner`, `internal`). | Plan offert. **Immune au downgrade Stripe** (cf §3.4 invariant 4). |
| `downgrade_auto` | Le Hub a décidé un downgrade automatique : subscription Stripe annulée/expirée, ou trial expiré sans conversion. | L'app applique son **mode dégradé paywall** (lecture seule, cf §5). |

> **Note de migration depuis v1.** Le `CONTRAT-HUB.md` v1.x exposait un
> `plan_source` à 5 valeurs métier (`stripe | manual | lifetime_site_vitrine
> | lifetime_partner | internal`). Le v2 **factorise** : les 3 valeurs
> "plan offert" deviennent `grant_manual` (le détail du sous-type — site
> vitrine vs partner vs internal — reste connu du Hub, pas nécessaire pour
> l'app : l'app a juste besoin de savoir "ce plan est immune Stripe").
> `stripe_trial` et `downgrade_auto` sont **nouveaux** en v2 (ils
> n'existaient pas comme valeurs explicites — le trial était implicite, le
> downgrade arrivait avec `plan_source=stripe plan=free`). Les apps
> doivent gérer les 4 valeurs v2 (cf tickets de conformité §5).

### 3.4 Invariants — non négociables

L'app commerciale qui consomme `update-plan` **DOIT** :

1. **Rejeter `400` si `contract_version` major inconnu.** Pas de
   best-effort. Si le Hub envoie `contract_version: "3.x"` et que l'app ne
   connaît que le major `2`, elle renvoie `400` plutôt que de deviner.
   Un major bump = breaking change explicite, coordonné cross-repo.
   Un minor bump (`2.0` → `2.1`) reste accepté par un consumer `2.x`.

2. **Rejeter `400` si `plan` hors enum.** `plan` ∈ `{free, pro, business,
   enterprise}`. Tout autre valeur = `400 invalid_plan` avec
   `details.allowed_plans`.

3. **Être idempotente sur `idempotency_key`.** Replay du même
   `idempotency_key` = no-op + `200`. Voir `CONTRAT-HUB.md` §5.11
   (header `Idempotency-Key`). Le Hub peut renvoyer le même `update-plan`
   suite à un retry Stripe — l'app ne doit pas double-appliquer.

4. **Plan offert immune au downgrade Stripe.** Un tenant qui a localement
   `plan_source = grant_manual` ne se fait **PAS** downgrader par un
   `update-plan` entrant avec `plan_source = stripe` (ou `downgrade_auto`).
   L'app renvoie `409 plan_source_immutable`. C'est la protection gravée
   `CONTRAT-HUB.md` §3.3 "immunité plans offerts" : si une subscription
   Stripe expire pour un tenant lifetime, le webhook ne doit pas le
   ramener à `free`. **Exception** : un `update-plan plan_source=grant_manual`
   PEUT écraser n'importe quel état (un admin Hub a toujours le dernier mot).

> Le Hub fait déjà respecter l'invariant 4 en amont (il **n'émet pas** de
> `downgrade_auto`/`stripe` vers un tenant qu'il sait `grant_manual`, cf
> §5). Le `409` côté app est une **défense en profondeur** : si le Hub se
> trompe, l'app protège quand même le plan offert.

### 3.5 Réponse `200`

```jsonc
{
  "tenant_id": "string (echo)",
  "plan": "string (echo)",
  "previous_plan": "string|null",
  "plan_source": "string (echo)",
  "applied_at": "ISO8601",
  "quotas_applied": { /* optionnel — quotas dérivés du plan, cf §5.17 CONTRAT-HUB */ }
}
```

### 3.6 Codes d'erreur

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | HMAC invalide ou drift > 5 min. |
| `invalid_payload` | 400 | Body non parseable, champ requis manquant, `contract_version` major inconnu. |
| `invalid_plan` | 400 | `plan` hors enum (`details.allowed_plans`). |
| `tenant_not_found` | 404 | `tenant_id` inconnu côté app (renvoyé après HMAC OK). |
| `plan_source_immutable` | 409 | Tentative de downgrade d'un tenant `grant_manual` par un `plan_source` Stripe. |
| `idempotency_key_replay` | 409 *(ou 200)* | `idempotency_key` déjà traité. L'app PEUT renvoyer `200` no-op (recommandé, plus simple côté Hub) ou `409` — au choix de l'app, documenté côté app. |

Format d'erreur standard : `CONTRAT-HUB.md` §5.10.

---

## 4. Fail-open — comportement App si Hub down

> **Une app ne dégrade, ne paywalle, ne bloque JAMAIS un user parce
> qu'elle n'a pas reçu un signal du Hub. En cas de doute → dernier état
> connu. Fail-open.**

Le billing hérite directement de la règle de résilience `CONTRAT-HUB.md`
§1.4 ("Hub source de vérité + résilience apps"). Appliquée au billing :

| Situation | Comportement attendu de l'app |
|---|---|
| **Hub down** | L'app garde le tenant dans son **plan actuel** (colonne locale `tenants.plan`) jusqu'au prochain `update-plan` reçu. Pas de downgrade par timeout. |
| **App n'a jamais reçu d'`update-plan`** pour un tenant | Plan par défaut `free`. Jamais un état dégradé. |
| **`update-plan` en retard** (Hub a propagé tard) | L'app applique le nouvel état quand il arrive. Entre-temps elle servait l'ancien — c'est correct, fail-open. |

### 4.1 Anti-pattern INTERDIT

```
❌ INTERDIT : un cron côté app du type
   "si pas reçu d'update-plan / de heartbeat du Hub depuis X jours,
    downgrade tous les tenants à free".
```

Ce mécanisme transforme un Hub down en panne de facturation pour des
clients qui paient. Un client qui paie ne perd jamais son plan parce que
**notre** infra a un souci. C'est l'inverse de la résilience.

### 4.2 Nuance — la résilience niveau 1 (`last_hub_sync_at`)

`CONTRAT-HUB.md` §1.4bis grave un mécanisme **optionnel** de mesure de
fraîcheur du lien Hub→app (`last_hub_sync_at`, phases Fresh/Stale/Dead).
Ce mécanisme **ne contredit pas le fail-open** :

- En phase **Dead** (> 72h sans aucune mutation Hub), l'app bloque les
  **writes** (`503 hub_sync_dead`) mais **les reads passent toujours** —
  le tenant reste lisible. C'est cohérent avec le fail-open lecture.
- Un état `soft_deleted` connu localement **prime** sur `hub_sync_dead`.
- Les routes admin Hub sont **exemptées** du blocage Dead (le Hub doit
  toujours pouvoir réveiller l'app en lui poussant une mutation).

La résilience niveau 1 est un garde-fou contre le **cache mort en
silence**, pas un downgrade automatique. Le downgrade reste **toujours**
une décision explicite du Hub via `update-plan plan_source=downgrade_auto`.

---

## 5. Dunning — `invoice.payment_failed`

Le **dunning** (cycle de relance d'un paiement échoué) est géré
**entièrement par le Hub**. Les apps commerciales ne le voient jamais —
elles voient uniquement l'`update-plan` final.

### 5.1 Le cycle

1. Stripe émet `invoice.payment_failed` (CB expirée, plafond, refus
   banque). Le Hub reçoit l'event sur `POST /api/webhooks`.
2. Le Hub log l'échec. Si `attempt_count ≥ 3`, alerte Telegram à Robert.
   **Le tenant reste actif** pendant toute la fenêtre de grâce : une CB
   expirée n'est pas un client perdu, c'est un client à relancer.
3. Stripe retry le paiement N fois selon la config du Dashboard Stripe
   (Smart Retries). Tant que Stripe relance, **aucun `update-plan` n'est
   propagé** : l'app ne sait même pas qu'il y a un souci de paiement.
4. **Si le paiement finit par passer** (`invoice.payment_succeeded`) → le
   tenant n'a jamais bougé, rien à propager.
5. **Si Stripe abandonne** → Stripe émet `customer.subscription.deleted` →
   le Hub dispatche `update-plan plan=free plan_source=downgrade_auto` →
   l'app applique alors son **mode dégradé paywall** (lecture seule).

### 5.2 Pourquoi le dunning reste côté Hub

- Le cycle de relance est une **logique Stripe + business** (combien de
  retries, sur combien de jours, quels emails de relance). C'est de
  l'orchestration billing pure — le rôle exact du Hub.
- Une app commerciale qui voudrait gérer le dunning devrait connaître
  l'état des invoices Stripe → elle devrait parler à Stripe → violation
  de la frontière §2.
- Le tenant ne doit pas clignoter `paywall` / `actif` au rythme des
  retries Stripe. L'app reçoit **un seul** signal net à la fin du cycle :
  soit rien (paiement repassé), soit `downgrade_auto`.

### 5.3 Mode dégradé paywall — rappel

Quand l'app reçoit `update-plan plan=free plan_source=downgrade_auto`,
elle applique le **mode dégradé obfusqué** spec'd `CONTRAT-HUB.md` §5.9 :

- Routes en lecture : champs sensibles obfusqués serveur (33% en clair +
  bullets `•`).
- Routes en écriture : `402 tenant_paywall` avec `upgrade_url`.
- Composant UI `<Paywall>` + `<BlurredText>` (cosmétique en plus de la
  sécu serveur).
- **Pas concerné** : un tenant `plan_source=grant_manual` n'a jamais de
  mode dégradé, même si un event Stripe arrive (invariant §3.4.4).

---

## 6. Réconciliation — rattraper un event manqué (POLL)

### 6.1 Le cas couvert

Cas extrême : le Hub est down **plus de 3 jours** — au-delà de la fenêtre
de retry de Stripe. Stripe abandonne son retry, l'event est définitivement
non livré au Hub, et donc jamais propagé aux apps. Un tenant peut alors
avoir un plan obsolète côté app (ex : il a upgradé sur Stripe pendant que
le Hub était mort, l'app ne l'a jamais su).

C'est rare (il faut > 72h de Hub down ET un changement de plan pile dans
cette fenêtre) mais le contrat doit le couvrir.

### 6.2 Décision arrêtée — POLL, pas ACK

> 🔒 **Décision tranchée par Robert (2026-05-22) : la réconciliation se
> fait en POLL.** L'app commerciale poll périodiquement le Hub pour
> resynchroniser son état billing. **Pas de mécanisme d'ACK.**

C'est une **décision figée**, pas une option ouverte. Pourquoi POLL :

- **Plus simple.** Un ACK explicite obligerait le Hub à tenir un état
  "cet `update-plan` a-t-il été acquitté par l'app ?" pour chaque
  propagation, avec une file de ré-envoi, un timeout, un état par couple
  (tenant, app). Le POLL n'a aucun état à tenir : l'app demande, le Hub
  répond l'état courant.
- **Auto-cicatrisant.** Un poll qui tourne en boucle finit toujours par
  rattraper n'importe quel event manqué, quelle qu'en soit la cause
  (Hub down long, bug de propagation, app down au moment du push).
- **Hors hot path.** Le poll est un cron lent côté app, jamais dans une
  requête utilisateur. Il n'ajoute aucune latence au login ni à une page.

### 6.3 L'endpoint `GET /api/tenants/{tenant_id}/billing-state`

Le Hub expose un endpoint de lecture de l'état billing courant d'un tenant :

```
GET /api/tenants/{tenant_id}/billing-state
Auth : HMAC app → Hub (Pattern A, le même HMAC que les autres calls m2m)

→ 200
{
  "tenant_id": "string",
  "plan": "free|pro|business|enterprise",
  "plan_source": "stripe|stripe_trial|grant_manual|downgrade_auto",
  "stripe_subscription_id": "string|null",
  "effective_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

| Code | Status | Sens |
|---|---|---|
| `unauthorized` | 401 | HMAC invalide. |
| `tenant_not_found` | 404 | `tenant_id` inconnu côté Hub. |

> **Statut d'implémentation** : ✅ **livré côté Hub 2026-05-23**
> (`app/api/tenants/[tenantId]/billing-state/route.ts`, lib
> `lib/billing/billing-state.ts` + HMAC `lib/billing/billing-state-hmac.ts`,
> tests `__tests__/api/tenants/billing-state.test.ts` +
> `__tests__/lib/billing/billing-state.test.ts`).
>
> Spécificités d'implé :
> - **Headers HMAC** : `X-Veridian-Hub-Signature` + `X-Veridian-Timestamp` +
>   `x-veridian-app` (Pattern A §6.1 canonique). Secret par app
>   `<APP>_HUB_API_SECRET` (réutilisation du secret existant Hub↔app).
> - **Pour un GET**, le `rawBody` signé est la string vide `""` — la
>   signature couvre `${timestamp}.""`.
> - **Privacy / isolation app** : un caller HMAC `notifuse` ne récupère
>   QUE l'état billing notifuse du tenant ; idem prospection. L'app
>   appelante est dérivée du header HMAC (secret-bound), pas d'un
>   paramètre exposé — usurpation = 401 (secret désync).
> - **Cache 10s TTL in-memory** (`Map` clé `(tenantId, app)`) — évite
>   spam DB sur un cron app agressif. Header debug `X-Veridian-Cache:
>   HIT|MISS` retourné.
> - **Rate-limit** : 60 req/min/secret (clé HMAC, pas IP — un secret
>   partage un bucket). 429 `Retry-After` si dépassé.
> - **Réponse minimaliste** : exactement les 6 champs du contrat (tenant_id,
>   plan, plan_source, stripe_subscription_id, effective_at, updated_at).
>   Pas plus, pas moins — toute extension future = bump `contract_version`.

### 6.4 Le pattern poll côté app

L'app commerciale câble un **cron lent** :

- **Fréquence** : ~1× par jour. Pas plus — ce n'est pas un mécanisme de
  sync temps réel, c'est un filet de sécurité pour les events manqués.
- **Hors hot path** : un job de fond, jamais dans une requête user.
- **Pour chaque tenant** (ou par batch) : `GET /api/tenants/{id}/billing-state`
  HMAC → comparer `plan` / `plan_source` avec l'état local → si écart,
  appliquer l'état du Hub localement (le Hub est source de vérité billing).
- **Pas d'ACK** : l'app applique en silence, ne renvoie rien au Hub.
- **Fail-open** : si le Hub répond `5xx` ou timeout, le poll **skip** ce
  tenant et réessaiera au prochain tour. Jamais de downgrade sur un poll
  qui échoue (cohérent §4).
- **Idempotent** : un poll qui voit le même état que le local = no-op.

> Le poll est un **complément** du push `update-plan`, pas un remplacement.
> Le push reste le chemin nominal (réactif, propagation immédiate). Le poll
> ne sert qu'à rattraper ce que le push a raté.

---

## 7. Trial — articulation avec la state machine

La trial state machine est **livrée côté Hub** (sprint v1.4, `lib/trial/`,
table `hub_app.tenant_trials`, cron `/api/cron/trial-tick`). Sa spec
complète vit dans `CONTRAT-HUB.md` §8bis + `PRICING-VERIDIAN.md`
"Flow trial complet". Ce contrat-ci grave **uniquement** son interface
billing avec les apps.

### 7.1 Le trial génère un `update-plan` typé `stripe_trial`

Quand la state machine active un trial Pro 15j (signal d'engagement reçu
+ cooldown 48h écoulé), le Hub dispatche :

```jsonc
{
  "contract_version": "2.0",
  "plan": "pro",
  "plan_source": "stripe_trial",   // ← clé : PAS "stripe"
  "stripe_subscription_id": null,  // pas de sub Stripe tant que pas de CB
  ...
}
```

### 7.2 `stripe_trial` ≠ `stripe` — l'app DOIT distinguer

| `plan_source` | Réalité | UI app | Facturation |
|---|---|---|---|
| `stripe_trial` | Essai gratuit Pro avec deadline | "Essai gratuit — Pro" + compte à rebours | **Aucune facture.** Pas de CB requise. |
| `stripe` | Abonnement Pro payant actif | "Abonné — Pro" | Factures Stripe réelles. |

Une app qui traiterait `stripe_trial` comme `stripe` afficherait "abonné"
à un user en essai et pourrait laisser croire à une facturation. C'est un
invariant : l'app **gère les 4 valeurs de `plan_source` distinctement**.

### 7.3 Fin de trial

- **Conversion** (CB ajoutée → sub Stripe active à J+15) : le dispatcher
  Stripe a déjà posé `plan=pro plan_source=stripe` via l'event de
  subscription. **Pas d'`update-plan` supplémentaire** du côté trial — le
  chemin Stripe a pris le relais.
- **Expiration sans CB** (rien fait pendant 15j) : le Hub dispatche
  `update-plan plan=free plan_source=downgrade_auto` → l'app passe en
  mode dégradé paywall (§5.3).

### 7.4 `activity_threshold_reached` — le SEUL flux billing app→Hub

Toute la chaîne billing est **Hub → app** (push `update-plan`) ou
**app → Hub en lecture** (poll `billing-state`, §6). **Une seule
exception** : le signal d'engagement métier qui **déclenche** le trial
remonte de l'app vers le Hub.

```
App ──webhook "tenant.activity_threshold_reached"──► Hub POST /api/webhooks/<app>
```

- **Notifuse** : émet `tenant.activity_threshold_reached` au **5e mail
  envoyé** (lifetime). C'est ce qui fait passer le tenant `eligible` dans
  `tenant_trials`.
- **Prospection** : seuil d'engagement à définir (ex : 5 leads scrapés).
  Tant qu'aucun webhook n'arrive, la state machine reste inactive pour ses
  tenants (= "free silencieux", comportement par défaut).
- **Transport** : webhook app→Hub standard `CONTRAT-HUB.md` §7 — auth
  `Bearer <APP>_WEBHOOK_TOKEN`, dédup `idempotency_key` fenêtre 24h.

> C'est un signal **métier** (l'app sait compter ses mails / ses leads),
> pas un signal **billing** : l'app ne dit pas "facture ce tenant", elle
> dit "ce tenant est engagé". Le Hub décide ensuite quoi en faire (trial,
> puis éventuellement facturation). La frontière §2 tient : l'app ne
> touche pas à la facturation, elle remonte un fait métier.

---

## 8. Stripe Customer = 1 humain, multi-app

### 8.1 Le modèle

- **1 `stripe_customer_id` = 1 user Hub = 1 humain.** Le Customer Stripe
  est résolu / créé par le Hub (`resolveStripeCustomerId`) au premier
  checkout, attaché au `hub_app.users.id`.
- **N subscriptions sous le même Customer.** Un humain peut payer
  Notifuse Pro **et** Prospection Pro **et** un bundle — chacune est une
  Subscription Stripe distincte sous le même Customer.
- C'est la cible "Compte Veridian unique" : 1 email → 1 Stripe Customer →
  N subscriptions.

### 8.2 `metadata.app` — routage du dispatch

Chaque Subscription Stripe porte une `metadata` qui identifie l'app cible :

| `metadata.app` | Le Hub dispatche `update-plan` vers |
|---|---|
| `notifuse` | Notifuse uniquement |
| `prospection` | Prospection uniquement |
| `bundle` | Notifuse **ET** Prospection (sur le même event Stripe) |

> En implémentation Hub actuelle, le routage s'appuie aussi sur
> `subscription_data.metadata.plan_key` posé à la création du checkout
> (`POST /api/billing/checkout`) — c'est la source de vérité `PlanKey`
> côté Hub, relue par le webhook pour savoir quelles apps notifier. La
> convention `metadata.app` de cette section et le `plan_key` doivent
> rester cohérents (cf ticket `pricing-sync-stripe-products`, qui fige la
> convention metadata Stripe Products/Prices du giga sprint).

### 8.3 Bundle = 1 subscription, 2 apps débloquées

Un bundle Veridian (`Veridian Pro` 49€, `Veridian Business` 149€) est
**une seule** Stripe Subscription. À sa création / mise à jour / annulation,
le dispatcher webhook propage `update-plan` à **Notifuse ET Prospection**
sur le même event. Les deux apps reçoivent le même `plan` (`pro` ou
`business`), avec le même `idempotency_key` racine décliné par app.

### 8.4 Achats one-shot (refill leads Prospection) — flux séparé

Le **refill leads Prospection** (achat de leads à la commande, Stripe
Checkout one-shot, grille dégressive `PRICING-VERIDIAN.md`) est un **flux
distinct de `update-plan`** — à ne jamais mélanger avec l'abonnement.

| | Abonnement SaaS (Free/Pro/Business) | Refill leads (one-shot) |
|---|---|---|
| Objet Stripe | Subscription (récurrent) | Checkout `mode=payment` (one-shot) |
| Signal vers l'app | `update-plan` (change le `plan`) | **PAS** `update-plan` — un signal de crédit dédié |
| Effet | Change le tier du tenant | Crédite N leads, ne touche pas le `plan` |

**Frontière** (cohérente §2) : le **Hub reste seul interlocuteur Stripe**,
y compris pour le Checkout one-shot des leads. Prospection ne crée pas la
session Checkout, ne reçoit pas le webhook Stripe `checkout.session.completed`
de l'achat de leads. Le Hub le reçoit, et propage à Prospection un
**signal de crédit dédié** — pas un `update-plan`.

### Signal de crédit leads — figé 2026-05-23 (v2.1)

Endpoint Prospection :
`POST <prospection>/api/tenants/{tenantIdOrEmail}/credit-leads`
(le path accepte UUID du Tenant Hub OU email owner, cf
`src/lib/hub/tenant-lookup.ts` veridian-prospection).

Auth : HMAC Pattern A (§6.1 `CONTRAT-HUB.md`).
- Header `X-Veridian-Timestamp: <ms>`
- Header `X-Veridian-Hub-Signature: <hex SHA-256>`
- Signature calculée sur `${timestamp}.${rawJsonBody}` avec
  `PROSPECTION_HUB_API_SECRET` (rotation séparée du HMAC update-plan).

Body purchase (refill payant) :
```
{
  "quantity": <int 1..100000>,
  "source": "purchase",
  "stripe_payment_id": "<pi_xxx | cs_xxx>",
  "idempotency_key": "<uuid v4 DÉTERMINISTE, dérivé de stripe event.id>",
  "contract_version": "2.0"
}
```

Body welcome (provisioning ou upgrade) :
```
{
  "quantity": <int > 0>,
  "source": "welcome",
  "welcome_plan": "freemium" | "pro" | "business",  // plan LOCAL Prospection
  "idempotency_key": "<uuid v4 DÉTERMINISTE, dérivé de tenant_id+welcome_plan>",
  "contract_version": "2.0"
}
```

Réponses :
- `200 { credited, balance }` — crédit appliqué
- `200 { credited: 0, balance, idempotent_replay: true }` — no-op
  anti-double-grant (l'idem-key vue, OU le palier welcome déjà crédité
  via l'index unique `(workspace_id, welcome_plan)`)
- `400 invalid_payload` — `contract_version` major ≠ 2
- `422 invalid_body` — welcome sans `welcome_plan`, purchase avec
  `welcome_plan`, `welcome_plan` hors enum
- `404 tenant_not_found`

Mapping plans canoniques Hub → local Prospection (à appliquer côté Hub
AVANT l'appel) :
- `free` → `freemium`
- `pro` → `pro`
- `business` → `business`
- `enterprise` → `business` (pas de palier enterprise local refill)

Retry policy (côté Hub, dispatch post-paiement) : 3 tentatives,
backoff 1s/3s. 4xx = pas de retry (payload rejeté, bug code-côté).
5xx + erreurs réseau = retry. Échec des 3 tentatives → alerte Telegram
`[CRITICAL][refill]` (le user a payé, ne JAMAIS perdre le crédit —
cron de réconciliation à câbler en P2).

Welcome leads — DELTA d'upgrade :
- Provision Free → `quantity: 100`, `welcome_plan: "freemium"`
- Upgrade Free→Pro → `quantity: 1900` (= 2000 − 100)
- Upgrade Pro→Business → `quantity: 6000` (= 8000 − 2000)
- Downgrade → **AUCUN appel** (leads permanents,
  cf `PRICING-VERIDIAN.md` §97)

Implémentation Hub : `lib/billing/refill-leads.ts` (lib pure),
`app/api/billing/refill-leads/checkout/route.ts` (Checkout one-shot),
`lib/stripe/dispatcher.ts` (route les webhooks Stripe avec
`metadata.kind=refill_leads`).

---

## 9. Matrice de conformité billing

Ce que chaque app commerciale doit avoir pour être conforme à ce contrat.

| Exigence | Référence | Notifuse | Prospection |
|---|---|---|---|
| Endpoint `POST /api/tenants/update-plan` | §3 | ✅ livré (à durcir v2) | ✅ livré (à durcir v2) |
| Lit `contract_version`, rejette `400` si major inconnu | §3.4.1 | ⏳ ticket conformité | ⏳ ticket conformité |
| Valide `plan` enum fermé | §3.4.2 | ⏳ ticket conformité | ⏳ ticket conformité |
| Gère les 4 `plan_source` (dont `stripe_trial`, `downgrade_auto`) | §3.3 | ⏳ ticket conformité | ⏳ ticket conformité |
| Idempotence sur `idempotency_key` | §3.4.3 | ⏳ ticket conformité | ⏳ ticket conformité |
| Plan offert immune (`409 plan_source_immutable`) | §3.4.4 | ✅ via `plan_source` existant | ✅ via `plan_source` existant |
| Fail-open : aucun cron downgrade-by-timeout | §4.1 | ⏳ ticket conformité | ⏳ ticket conformité |
| Mode dégradé paywall sur `downgrade_auto` | §5.3 | ✅ livré (§5.9) | ✅ livré (§5.9) |
| Émet `activity_threshold_reached` | §7.4 | ✅ livré (5e mail) | 🔵 seuil à définir |
| Ne reçoit jamais de webhook Stripe | §2 | ✅ conforme | ✅ conforme |
| N'appelle jamais l'API Stripe en écriture | §2 | ✅ conforme | ✅ conforme |
| Cron poll `billing-state` ~1×/jour | §6.4 | 🔵 à câbler (après endpoint Hub) | 🔵 à câbler (après endpoint Hub) |

> Les lignes ⏳ sont couvertes par les tickets de conformité
> `2026-05-22-aligner-contrat-billing-v2.md` déposés dans
> `notifuse-veridian/todo/` et `veridian-prospection/todo/`.
>
> Les lignes 🔵 `billing-state` poll dépendent de la livraison de
> l'endpoint Hub `GET /api/tenants/{id}/billing-state` (§6.3) — non
> bloquant, filet de sécurité du cas extrême.

---

## 10. Changements

### v2.0 — 2026-05-22

- **Création du contrat.** Extraction de la partie billing du monolithe
  `CONTRAT-HUB.md` (ticket `veridian-hub/todo/2026-05-22-extraire-contrat-billing.md`).
  Sources extraites : `CONTRAT-HUB.md` §1.4 (résilience), §1.4bis (billing
  résilience niveau 1), §3.3 (immunité plans offerts), §5.2 (update-plan),
  §5.9 (mode dégradé paywall), §7.4 (chaîne Stripe→Hub→apps), §8 (pilotage
  plans), §8bis (trial state machine). `CONTRAT-HUB.md` conserve ces
  sections sous forme de **pointeurs courts** vers ce contrat — la
  numérotation `§x.y` du contrat Hub n'a pas changé (ancres préservées).
- **Périmètre** : apps commerciales SEULEMENT (Notifuse + Prospection).
  Exclusion explicite et figée de CMS / Analytics.
- **Frontière Stripe unidirectionnelle gravée** (§2) : UN seul endpoint
  Stripe (`POST /api/webhooks` côté Hub), avec la justification complète
  pour que l'architecture multi-listeners ne soit jamais re-proposée.
- **Payload `update-plan` v2** (§3) : versionné (`contract_version: "2.0"`),
  enum `plan` fermé, enum `plan_source` refactorisé à 4 valeurs
  (`stripe | stripe_trial | grant_manual | downgrade_auto` — `stripe_trial`
  et `downgrade_auto` nouveaux ; les 3 sous-types lifetime factorisés en
  `grant_manual`). Champs `effective_at`, `stripe_subscription_id`,
  `idempotency_key` figés.
- **Fail-open** (§4) gravé : aucune dégradation sur silence du Hub,
  anti-pattern cron downgrade-by-timeout interdit.
- **Dunning** (§5) : entièrement Hub-side, les apps voient l'`update-plan`
  final, pas le cycle de relance.
- **Réconciliation** (§6) : décision Robert tranchée = **POLL** (cron lent
  app → `GET /api/tenants/{id}/billing-state` HMAC, ~1×/jour, pas d'ACK).
  Endpoint `billing-state` spec'd, implémentation Hub = ticket séparé.
- **Trial** (§7) : articulation avec la state machine livrée v1.4,
  `stripe_trial` distinct de `stripe`, `activity_threshold_reached` gravé
  comme seul flux billing app→Hub.
- **Stripe Customer multi-app** (§8) : 1 humain = 1 Customer = N
  subscriptions, `metadata.app` route le dispatch, bundle = 1 subscription
  → 2 apps.
- **Mapping plan canonique ↔ local** (§3.2bis) : l'enum `plan` du payload
  est canonique cross-app ; le nom local d'une app (`freemium` côté
  Prospection pour `free`) est un détail d'affichage qui ne franchit
  jamais l'API.
- **Refill leads one-shot** (§8.4) : gravé comme flux **séparé** de
  `update-plan` — le Hub reste seul interlocuteur Stripe pour le Checkout
  one-shot des leads, l'app reçoit un signal de crédit dédié (endpoint
  exact à spec'er dans un ticket ultérieur).

> **Lignée.** Ce contrat démarre en `v2.0` (pas `v1.0`) pour aligner son
> numéro de version sur le `contract_version` du payload `update-plan`.
> Il n'a pas de prédécesseur autonome — son "v1 implicite" était la
> section billing diffuse de `CONTRAT-HUB.md` v1.x.

---

## Source primaire & maintenance

- **Ce fichier** est la source de vérité technique billing cross-app.
  Symlink racine : `veridian-platform/CONTRAT-BILLING.md`.
- Toute évolution du payload `update-plan`, de la frontière Stripe, du
  pattern de réconciliation passe par un bump de version ici + mise à
  jour du changelog §10 + coordination cross-app (tickets `todo/` dans
  les apps commerciales).
- Cohérence à maintenir avec : `PRICING-VERIDIAN.md` (métier),
  `CONTRAT-HUB.md` (intégration non-billing), `CONTRAT-HUB-API-REF.md`
  (référence API — section "Billing & Pricing" + "Stripe webhook
  orchestrator").
