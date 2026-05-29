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

## Reste à faire

### 1. 🔴 `19-crm-card-dashboard-flow.spec.ts` cassé par le gating TenantApp

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
