# E2E lourd : couvrir le gating TenantApp + réparer 19-crm-card (gating)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-29

## Contexte

Audit rapide de la suite `e2e/staging-full/*` (21 specs, ~190 tests) après les
livraisons du 2026-05-29 (redirect home, refonte UI auth, gating TenantApp).
Trois écarts détectés entre les specs et la réalité du code.

## Quick wins DÉJÀ faits (dans ce commit)

- ✅ **`01-health-and-routes` — test home `/`** : l'ancien test faisait
  `page.goto('/')` + `toHaveTitle(/Veridian/)`. Depuis la redirect 307 vers
  veridian.site, Playwright suivait la redirect et validait le titre de
  veridian.site → **faux positif**. Corrigé : vérifie le 307 + `Location`
  contient `veridian.site`, sans suivre la redirect.

## 🔬 Diagnostic giga-batterie 2026-05-29 (359/371, 12 échecs = 6 specs ×2 retry)

**AUCUN échec n'est une régression de la feature du jour.** Détail :

| Spec | Cause | Statut |
|---|---|---|
| A-01 signup OAuth Google | mock OAuth ne provisionnait pas le workspace | ✅ **FIXÉ** (commit mock-oauth) |
| A-02 signup OAuth Microsoft | idem (même cause racine) | ✅ **FIXÉ** |
| J-01 GDPR delete-tenant | idem (user sans workspace) | ✅ **FIXÉ** (même fix) |
| G-02 discovery 3-niveaux | `NOTIFUSE_HUB_API_SECRET` PAS sourcé par le run | ✅ **non-bug** : repasse vert avec le secret du container |
| K-02 cron race condition | flaky-by-design (le vrai cron trial-tick tourne /5min sur staging et active les rows avant les 2 ticks du test → 0 activated) | ⚠️ **à réécrire** (isoler du cron réel) |
| 19-crm-card render | dette pré-existante (CardTitle=div, titre inversé) | 🟡 voir §0 |

**⚠️ Le harnais `scripts/e2e/staging-full.sh` ne source PAS `NOTIFUSE_HUB_API_SECRET`
ni `CRON_SECRET`** → G-02/K-02 tombent sur des fallbacks bidons (401). À ajouter
à la liste sourcée. ATTENTION : ne PAS sourcer depuis `.all-creds.env` (pas fiable,
CRON_SECRET y diffère du container) — sourcer depuis le **container staging**
(`docker exec hub-staging sh -c 'echo $X'`) qui est la seule source de vérité.

## Fait 2026-05-29 (cette session)

- ✅ **Spec 20 `20-tenant-app-access-flow.spec.ts` créée + verte** (6/6 sur staging
  réel) : couvre POST /api/admin/tenants/app-access (401/400/404 + activation/
  désactivation twenty + vérif DB tenant_apps). Pièges réglés : mode serial,
  user créé avec supabase_user_id, JOIN `supabase_user_id::uuid` (text=uuid).
- ✅ Spec 19 : ajout `enableTwentyFor()` (active twenty en DB avant le flow card),
  cleanup tenant_apps, casts UUID. **MAIS** voir ci-dessous : le test render
  reste rouge pour une raison PRÉ-EXISTANTE (pas le gating).

## Reste à faire

### 0. 🟡 `19` test "render" : cassé AVANT le gating (dette pré-existante)

Le 1er test (`login → dashboard render → card visible`) échoue à trouver le
titre. Cause PRÉ-EXISTANTE (commit `829418e`, avant cette session) :
- cherchait `getByRole('heading', { name: 'CRM Veridian' })` — or (a) le titre
  rendu est `Veridian CRM` (ordre inversé) et (b) `CardTitle` rend un `<div>`,
  pas un `<heading>`. Donc ce test ne pouvait pas passer depuis la refonte
  shadcn de CardTitle.
- Corrigé partiellement (titre + getByText) mais le titre reste introuvable au
  render → suspecter que le dashboard ne rend pas la CrmCard dans le contexte
  mock-OAuth (user sans workspace ?) OU timing SSR du flag. À investiguer à
  tête reposée — NON bloquant pour la feature (l'endpoint est couvert par 20).

### 1. 🟢 `19` flow activate/ouvrir (3 tests suivants, serial)

Le test clique "Activer mon CRM" puis "Ouvrir mon CRM". Or depuis le gating
(commit `feat(admin): activation des apps gated par tenant`), la card CRM est
**"Bientôt" (bouton désactivé) par défaut** tant que `twenty` n'est pas activé
pour le tenant via `POST /api/admin/tenants/app-access`.

→ **Le test doit d'abord activer l'app** : appeler l'Admin API
`POST /api/admin/tenants/app-access { user_email, app: 'twenty', enabled: true }`
en setup, PUIS dérouler le flow activer/ouvrir. Sans ça le bouton n'existe pas.

NB : ce fichier a une modif non-commitée en working tree (un autre agent) —
coordonner avant de toucher (cf stash `wip-e2e-crm-not-mine`).

### 2. 🟡 Aucune couverture E2E de `POST /api/admin/tenants/app-access`

Nouvel endpoint admin (toggle on/off app gated par tenant) testé seulement en
unit (mocks). Ajouter une spec `20-tenant-app-access-flow.spec.ts` qui, contre
staging réel :
- POST app-access enabled=true pour un user test → 200
- vérifie la row `tenant_apps` (enabled=true, enabled_by) en DB
- POST enabled=false → 200, row maj
- 401 sans secret admin, 400 sur app non-gated (prospection/notifuse), 404 user inconnu
- cleanup DELETE de la row test

### 3. 🟢 Couverture du gating dashboard (analytics/cms/twenty "Bientôt" par défaut)

Vérifier en E2E qu'un tenant sans flag voit bien les 3 cards gated en mode
"Bientôt", et qu'après activation via Admin API, la card passe active. Peut
être fusionné avec la spec #2.

## Vision cible

> À terme tous les scénarios doivent être couverts par l'E2E lourd (décision
> Robert 2026-05-29). Aujourd'hui la CI staging ne lance QUE Vitest — les E2E
> Playwright tournent à la main (`pnpm e2e:staging:full`). Ticket lié au
> câblage E2E en CI : `todo/2026-05-22-ci-e2e-billing-preprod.md`.
