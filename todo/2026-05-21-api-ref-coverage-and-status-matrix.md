# Compléter `CONTRAT-HUB-API-REF.md` — couverture exhaustive + statut par endpoint

**Créé** : 2026-05-21
**Trigger** : un autre agent (probablement Hub side) a réécrit le contrat
en v1.4 et créé `docs/CONTRAT-HUB-API-REF.md` (1277 lignes) comme compagnon
technique. Le doc est solide sur le format mais **mélange spec future et
réalité d'implémentation** sans le dire — un agent qui le lit littéralement
pour implémenter va se planter sur les endpoints non livrés.

## Constat

### Ce qui existe (commit en cours)

`docs/CONTRAT-HUB-API-REF.md` 1277 lignes documente **22 endpoints
cross-app** (Hub ↔ apps downstream), répartis ainsi :

**Sens Hub → apps downstream (=spec que les apps doivent implémenter)** :
- `PROV` provision, `PLAN` update-plan, `OWN` attach-owner, `SUSP` suspend,
  `RES` resume, `HEALTH`, `MAGIC` magic-link, `SOFT`/`REST`/`PURGE`
  lifecycle, `TOUCH` webhook
- `USAGE` summary, `USER` lookup côté Hub, `EMAIL` by-email côté app,
  `ROT` rotate-api-key, `TRANS` transfer-owner
- `SYNC`/`RM`/`RESTM`/`FREEZE`/`UNFREEZE` member management
- `ATTACH` workspace-level attach-member (nouveau v1.4 P1 invitation)

**Sens app → Hub (=endpoints Hub côté webhooks/management)** : moins
documenté pour l'instant (juste mention des webhooks dans la TOC).

### Le problème

L'API-REF décrit la cible v1.4 mais **ne distingue pas** :

1. **Endpoint livré et en prod** (ex. PROV chez Notifuse, livré depuis 2026-05)
2. **Endpoint livré partiellement** (ex. P1 invitation : 5/9 étapes seulement,
   cf. `project_invitation_endpoints_progress_2026-05-21.md`)
3. **Endpoint spec uniquement, pas encore implémenté** (probablement
   FREEZE/UNFREEZE, TOUCH, USAGE selon l'âge de la grav v1.3/v1.4)
4. **Endpoint déprécié dans le futur**

Conséquence : un agent qui lit l'API-REF sans cross-référencer `§10` du
contrat (la matrice de conformité) va **implémenter ou attendre des
endpoints qui n'existent pas** côté Hub ou côté apps.

### Aussi : Hub côté serveur n'est pas couvert

L'API-REF documente le contrat **vers les apps downstream**. Mais le Hub
lui-même expose ~50 routes (voir `app/api/`) qui ne sont pas dans l'API-REF :

- `/api/admin/*` (12 routes admin) — Admin API livrée 2026-05-20
  ([reference_hub_admin_api](../../../.claude/projects/-home-brunon5-Bureau-veridian-platform-veridian-hub/memory/reference_hub_admin_api.md))
- `/api/auth/*` (Auth.js handlers + signup + MFA)
- `/api/invitations/*` (4 routes P1 invitation Hub-side, livrées 2026-05-21
  cf. `reference_hub_invitation_hmac_contract.md`)
- `/api/billing/checkout`, `/api/webhooks/notifuse`, `/api/webhooks` (Stripe)
- `/api/tenants/*` (start, retry, status — provisioning Hub-side)
- `/api/notifuse/create-tenant`, `/api/prospection/regenerate-login`
- `/api/cron/*` (cleanup-orphan-users, cleanup-trials)
- `/api/workspace/*` (invite, members management)
- `/api/health`, `/api/config`, `/api/account/*`

Aucune trace dans l'API-REF. Un agent qui veut consommer ces routes (ex.
script ops, autre app qui appelle Hub, dashboard admin externe) doit
deviner les contrats en lisant le code.

## Travail à faire

### P0 — Matrice de statut par endpoint dans l'API-REF

Pour CHAQUE endpoint listé dans l'API-REF actuel (22 endpoints), ajouter
une ligne juste sous le titre `### XXX — POST /api/...` :

```markdown
**Statut** : ✅ livré prod | ⏳ partiellement livré (X/Y étapes) | 📋 spec only | 🗄 déprécié
**Implémenté côté** : Notifuse ✅ · Prospection ✅ · Hub ⏳ (route TODO)
**Dernière vérif** : 2026-05-21
```

Source de vérité pour le statut :
- Hub-side : grep `app/api/` du Hub + lecture des memories `reference_hub_*`
- Apps downstream : interroger les agents Notifuse/Prospection via leurs
  `todo/` ou via les memories `reference_hub_notifuse_*` et équivalents

⚠️ **Ne pas faire confiance aveuglément à la matrice §10 du contrat** :
elle a aussi été mise à jour par l'agent en v1.4 et peut avoir des trous.
Croiser au minimum (a) le code réel via grep + lecture, (b) les memories,
(c) la matrice §10.

### P1 — Compléter l'API-REF côté Hub (routes manquantes)

Ajouter une nouvelle section dans l'API-REF :

```
## Endpoints Hub (consommés par admin / cron / apps)

### ADMIN-USER-CREATE — POST /api/admin/users/create
...

### ADMIN-USER-GET — GET /api/admin/users/[email]
...

### ADMIN-LINK-APP — POST /api/admin/tenants/link-app
...

[etc. pour les 50 routes, classées par scope]
```

Format identique à l'existant (Direction / Auth / Trigger / Idempotent on
+ Request / Response / Codes erreur / Notes / Tests obligatoires).

**Tri par scope** :
- `## Endpoints Auth & Account` (login, signup, MFA, password)
- `## Endpoints Admin API` (les 12 routes `/api/admin/*`)
- `## Endpoints Billing & Webhooks` (Stripe + Notifuse webhooks)
- `## Endpoints Tenant lifecycle Hub-side` (start, retry, status)
- `## Endpoints Workspace Hub-side` (members, invite)
- `## Endpoints Invitation P1` (create, verify, accept, revoke)
- `## Endpoints Cron` (cleanup-*, à documenter pour ops)
- `## Endpoints Public` (health, config — pas de auth)

### P2 — Scénarios end-to-end (cross-endpoint flows)

Le doc actuel décrit chaque endpoint **isolément**. Or les bugs viennent
quasi-toujours des **flows multi-endpoints**. Ajouter une section :

```
## Scénarios end-to-end

### Flow 1 — Signup → premier login Notifuse
1. User → POST /api/auth/signup (Hub Credentials)
2. Hub → event createUser → patch supabaseUserId (cf. memory)
3. User → click "Commencer essai" carte Notifuse → POST /api/tenants/start
4. Hub → POST /api/tenants/provision (HMAC vers Notifuse)
5. Hub → store api_key + magic_link
6. User → redirect vers magic_link → Notifuse login

Endpoints touchés : SIGNUP, PROV, MAGIC.
Tests obligatoires : flow complet en E2E sur staging.

### Flow 2 — Stripe upgrade Pro → propage quota apps
### Flow 3 — User accepte invitation cross-app
### Flow 4 — Admin créé tenant manuellement (mode service)
### Flow 5 — Hub down → app continue à servir (résilience §1.4)
### Flow 6 — Soft-delete → restore avant 30j
### Flow 7 — Soft-delete → purge après 30j (RGPD)
[etc.]
```

Chaque flow = une vérification que les endpoints individuels se composent
proprement. C'est ce qui aurait catché le bug `supabaseUserId NULL` du
2026-05-21 (le flow "Signup OAuth → Dashboard" n'était documenté nulle part).

### P3 — Convention pour les futurs endpoints

Graver dans le contrat (`docs/CONTRAT-HUB.md` §5 ou nouveau §5bis) :

> **Tout nouvel endpoint cross-app DOIT être documenté dans
> `CONTRAT-HUB-API-REF.md` AVANT d'être implémenté** (TDD doc-first).
> Le PR qui livre l'endpoint inclut obligatoirement la modif de l'API-REF.

Et étendre `scripts/ci/check-test-mapping.sh` pour vérifier que toute
nouvelle route `app/api/*/route.ts` a sa section dans l'API-REF — sinon
pre-push bloque.

## Pré-requis avant de commencer

- **Avoir le commit v1.4 mergé sur main** (ce n'est pas fait au moment où
  ce ticket est créé — l'agent qui a écrit le contrat doit le commit
  d'abord, sinon je risque de réécrire sur un draft instable)
- **Lire le ticket P1 invitation** (`project_invitation_endpoints_progress_2026-05-21.md`)
  pour les étapes effectivement livrées vs à venir
- **Lire la matrice §10** du contrat v1.4 pour ne pas dupliquer ou contredire

## Risques / pièges anticipés

- **Drift doc/code** : si je documente un endpoint comme ✅ livré mais qu'en
  réalité l'implémentation diverge (ex. paramètre ajouté/retiré), je crée
  du faux signal. → Pour chaque endpoint marqué ✅, faire un curl réel
  contre staging ou prod et vérifier que la réponse matche le schema.
- **Endpoints v1.3 obsolètes** : la matrice §10 a peut-être des lignes
  périmées. Demander à Robert d'arbitrer si conflit doc/code/memory.
- **Apps downstream pas dispo** : pour le statut "implémenté côté
  Notifuse/Prospection", je n'ai pas accès direct au code de ces repos.
  Soit déposer des tickets dans leur `todo/` pour qu'elles me répondent,
  soit lire leurs `docs/` qui sont accessibles via la racine polyrepo.
- **Volume** : compléter 50 endpoints + 7 flows = gros morceau (2-4h).
  Phasing recommandé : P0 d'abord (1h), P1 par scope (1h par scope), P2
  ensuite, P3 en dernier.

## Définition of Done

- [ ] Chaque endpoint API-REF actuel a sa ligne **Statut / Implémenté côté
      / Dernière vérif**
- [ ] Les 50 routes Hub `app/api/*` ont leur section dans l'API-REF
- [ ] Au moins 7 scénarios end-to-end documentés (signup, billing, invitation,
      admin, résilience, soft-delete, purge)
- [ ] Convention "doc-first" gravée dans le contrat §5bis
- [ ] Pre-push hook vérifie que toute nouvelle route a sa section API-REF
- [ ] Memory `reference_api_ref_status_matrix.md` créée pour rappeler la
      convention aux futures sessions
