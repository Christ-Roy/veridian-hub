# [HUB] 🔵 P3 — Carte dashboard "Prospects chauds" (afficher le score d'engagement)

> **Sévérité** : 🔵 P3 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)
> **Type** : feature UI — visualise la SORTIE du réconciliateur

## Contexte (prouvé par audit 2026-06-17)

Aucun écran du Hub ne lit `prospect_scores`. Preuve :

- `grep -rni 'prospect|engagement|score' app/dashboard/` → uniquement des faux
  positifs (`Prospection` l'app, `leadScore` billing, `refill-leads`). **Aucune
  référence à `prospect_scores` / `engagementScore`.**
- `app/dashboard/page.tsx` = cards apps (Prospection/Notifuse/CRM) ;
  `app/dashboard/admin/analytics/page.tsx` = provisioning tenants Analytics.
  Ni l'un ni l'autre n'affiche de prospect chaud.

## Demande précise

Ajouter une **carte "Prospects chauds"** quelque part de pertinent :

- **Option A (admin global)** : section dans `app/dashboard/admin/` listant le
  top N prospects par `engagementScore` tous workspaces confondus — vue
  pilotage pour Robert.
- **Option B (par workspace user)** : carte sur le dashboard du user affichant
  ses prospects les plus engagés (si on veut l'exposer au client final).

Reco : **Option A d'abord** (outil interne Robert, pas de risque produit).

Contenu de la carte :
- Tableau : email prospect · score · dernier event (`lastEventAt`) · breakdown
  signaux (`{opened, clicked, replied, page_hit}` depuis `signals`).
- Tri par score décroissant, badge couleur par palier de chaleur.
- Lien direct vers le `people` correspondant dans le CRM Twenty (si le push
  CRM est câblé — cf `2026-06-17-push-score-prospect-vers-crm-twenty.md`).

Data : consommer **`GET /api/admin/prospect-scores`**
(`2026-06-17-api-admin-read-prospect-scores.md`) — ne PAS requêter Prisma
directement depuis un composant client.

Respecter le design system OKLCH (jamais de couleur hardcodée — cf CLAUDE.md Hub).

## Impact business

Le moins prioritaire des trois : confort de visualisation. Le push CRM
(`2026-06-17-push-score-prospect-vers-crm-twenty.md`) délivre déjà la valeur
opérationnelle (priorisation dans le CRM que Robert utilise au quotidien). Ce
dashboard est un doublon de confort tant que le CRM affiche déjà le score.

## Dépendances

- **Dépend de** `2026-06-17-api-admin-read-prospect-scores.md` (la carte lit
  cet endpoint). À faire après.
- À arbitrer : si le CRM Twenty affiche déjà `people.prospectScore` trié, ce
  dashboard fait peut-être doublon → demander à Robert s'il le veut vraiment.

## Tier de risque (CI-ARCHITECTURE §20)

🟡 MOYEN (UI dashboard admin + lecture via endpoint existant). Promotion agent
autonome après reco + smoke CI.
