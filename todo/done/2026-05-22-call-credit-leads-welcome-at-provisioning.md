# [HUB] Appeler credit-leads source=welcome au provisioning / upgrade Prospection

> **Sévérité** : 🟡 P1 — sans ça un nouveau tenant Prospection a 0 lead exploitable
> **Owner** : agent Hub
> **Créé** : 2026-05-22 (déposé par l'agent billing-refill / Prospection)
> **Réfère** :
>   - `docs/PRICING-VERIDIAN.md` §78 (welcome leads par plan)
>   - `docs/CONTRAT-BILLING.md` §8.4 (refill = flux séparé)
>   - `veridian-prospection` ticket `todo/done/2026-05-22-refill-2-welcome-leads-grant.md`

## Contexte

Les "welcome leads" : un lot de leads OFFERT one-shot à la souscription
d'un plan Prospection, proportionnel au plan. Grille (source de vérité
`shared/pricing/plans.ts`, champ `welcome_leads`) :

| Plan local Prospection | welcome_leads |
|---|---|
| `freemium` | 100 |
| `pro` | 2 000 |
| `business` | 8 000 |

Aujourd'hui non câblé : Prospection provisionne un tenant avec
`leadsCredited = 0` — le nouveau client ne peut rien faire.

**Architecture tranchée : option A — le Hub orchestre le grant.** Le Hub
est seul maître du billing (`CONTRAT-BILLING.md`). Prospection ne crédite
jamais elle-même : elle expose l'endpoint, le Hub l'appelle.

## Côté Prospection — DÉJÀ LIVRÉ

L'endpoint `POST /api/tenants/{id}/credit-leads` est en place et accepte
désormais les grants welcome. Contrat actuel :

```
POST /api/tenants/{tenantId}/credit-leads
Auth : HMAC Hub standard (Pattern A, CONTRAT-HUB.md §6.1)
Body :
  {
    "quantity": 1900,                 // entier > 0 — le DELTA à créditer
    "source": "welcome",
    "welcome_plan": "pro",            // REQUIS si source='welcome'
                                      // enum LOCAL : freemium | pro | business
    "idempotency_key": "<uuid-v4>",
    "contract_version": "2.0"
  }
Réponses :
  200 { credited, balance }                          → crédit appliqué
  200 { credited: 0, balance, idempotent_replay }    → no-op anti-double-grant
  200 { credited, balance, idempotent_replay }       → replay même idem-key
  400 invalid_payload                                → contract_version major ≠ 2
  422 invalid_body                                   → welcome sans welcome_plan,
                                                       purchase avec welcome_plan,
                                                       welcome_plan hors enum
  404 tenant_not_found
```

Points importants du contrat côté Prospection :

1. **`welcome_plan` est obligatoire** sur un grant `source=welcome`. C'est
   le nom de plan **LOCAL Prospection** (`freemium | pro | business`),
   PAS l'enum canonique du fil (`free | pro | business | enterprise`).
   Le Hub doit mapper avant d'appeler — même mapping que `update-plan`
   (`free → freemium`, `enterprise → business`).

2. **Anti-double-grant garanti en DB** : Prospection a un index unique
   `(workspace_id, welcome_plan)`. Un second grant welcome pour un palier
   déjà crédité (même si `idempotency_key` différent) renvoie un
   `200 { credited: 0, idempotent_replay: true }`. Le Hub peut donc
   réessayer sans risque — l'invariant "1 welcome par palier" est tenu
   côté Prospection, pas seulement par la discipline du Hub.

3. **Le Hub crédite le DELTA entre paliers**, pas le total :
   - Provision Free → `quantity: 100`, `welcome_plan: "freemium"`
   - Upgrade Free → Pro → `quantity: 1900`, `welcome_plan: "pro"`
     (1900 = 2000 du palier Pro − 100 déjà donnés au palier Free)
   - Upgrade Pro → Business → `quantity: 6000`, `welcome_plan: "business"`
     (6000 = 8000 − 2000)
   - **Downgrade → aucun appel** (les leads sont permanents, jamais retirés).

   Le calcul du delta est à la charge du Hub (il connaît l'ancien plan).
   Si le Hub se trompe et renvoie un grant déjà accordé, le garde DB
   l'absorbe en no-op.

## Demande côté Hub

1. **Au provisioning d'un tenant Prospection** (après l'appel
   `POST /api/tenants/provision` qui crée le workspace) : appeler
   `credit-leads` avec `source=welcome`, `welcome_plan` = plan local du
   tenant, `quantity` = `welcome_leads` de ce plan (depuis
   `shared/pricing/plans.ts`).

2. **À l'upgrade de plan** (handler `update-plan` Hub, quand le nouveau
   plan a un `welcome_leads` supérieur à l'ancien) : appeler `credit-leads`
   avec `source=welcome`, `welcome_plan` = nouveau plan local,
   `quantity` = `welcome_leads(nouveau) − welcome_leads(ancien)`.

3. **Idempotency_key** : générer un UUID v4 **stable et déterministe**
   par (tenant, palier) — ex. dérivé d'un hash `tenant_id:welcome_plan` —
   pour que les retries Hub réémettent la même clé. Le garde par palier
   côté Prospection couvre déjà le cas où la clé diffère, mais une clé
   stable rend le replay propre.

4. **Quantités lues depuis `shared/pricing/plans.ts`** (`welcome_leads`),
   jamais en dur — c'est la source de vérité cross-app.

5. **Downgrade** : ne déclencher AUCUN appel `credit-leads` (les welcome
   leads sont permanents, cf `PRICING-VERIDIAN.md` §97).

## Tests attendus côté Hub

- Provision Prospection Free → 1 appel `credit-leads` welcome
  `quantity=100 welcome_plan=freemium`.
- Upgrade Free→Pro → 1 appel `quantity=1900 welcome_plan=pro`.
- Upgrade Pro→Business → 1 appel `quantity=6000 welcome_plan=business`.
- Downgrade Business→Pro → AUCUN appel.
- `update-plan` rejoué (même idempotency) → pas de re-grant (clé stable +
  garde DB Prospection).

## Impact si non fait

Bloquant produit : tout nouveau tenant Prospection a un solde de leads à
0 et ne peut consulter aucune fiche. L'endpoint Prospection est prêt et
attend l'appelant — c'est le seul maillon manquant.

## Priorité

P1. À câbler dès que le sprint billing Hub le permet.
