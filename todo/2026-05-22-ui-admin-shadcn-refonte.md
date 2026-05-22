# UI — Refonte des écrans admin en composants shadcn

> **Sévérité** : 🟡 P1 — dette UI, écrans internes mais aussi utilisés en support client
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : audit précédent `todo/done/2026-05-21-ui-audit-coherence.md` §8 "Sprint A"

## Contexte

L'audit UI du 2026-05-21 a déjà fait passer l'admin sur les tokens OKLCH (plus
aucune couleur hardcodée — vérifié, `grep` propre). **Mais le reste du Sprint A
n'a pas été fait** : les écrans admin utilisent encore des éléments HTML natifs
au lieu des composants shadcn, ce qui crée une "stack visuelle parallèle" au
reste du dashboard.

État actuel :

- **`app/dashboard/admin/tenants/page.tsx`** :
  - `<table>` HTML natif au lieu de `<Table>` shadcn.
  - `<select>` natifs pour les plans Prospection / Notifuse.
  - `<input type="date">` natif pour le trial.
  - `<input type="text">` natif pour le filtre + `<button>` natif "Impersonate".
  - Pas de `<DashboardPageHeader>` (titre fait à la main en `<h1 text-2xl>`).
  - **Pas de `overflow-x-auto`** sur le wrapper de la table à 7 colonnes →
    risque de débordement horizontal sale sur mobile/écran étroit.
  - `confirm()` natif du navigateur pour supprimer un trial.
- **`app/dashboard/admin/page.tsx`** : pseudo-cards `<div className="bg-card
  border rounded-lg p-6">` au lieu de `<Card>` shadcn (tokens OK, structure non).
- **`app/dashboard/admin/analytics/page.tsx`** : `<input>`, `<button>`,
  `<select>`, `<details>` natifs pour tous les formulaires de création/édition
  de tenant. Pas de composants shadcn.
- **`app/dashboard/admin/layout.tsx`** : header propre (tokens OK) mais isolé —
  shunte la `AppSidebar`. Décision à prendre : garder l'isolement (alors header
  cohérent suffit) ou réintégrer le dashboard.

## Travail à faire

1. **`admin/tenants/page.tsx`** : convertir en `<Table>` / `<TableHeader>` /
   `<TableRow>` / `<TableCell>` shadcn. Remplacer les `<select>` par `<Select>`,
   l'`<input>` filtre par `<Input>`, le bouton "Impersonate" par `<Button>`.
   Ajouter `overflow-x-auto` sur le wrapper. Remplacer le `confirm()` natif par
   un `<AlertDialog>` shadcn (le composant existe dans `components/ui/`).
   Ajouter `<DashboardPageHeader>`.
2. **`admin/page.tsx`** : remplacer les pseudo-cards par `<Card>` / `<CardHeader>` /
   `<CardContent>`.
3. **`admin/analytics/page.tsx`** : convertir les formulaires en `<Input>`,
   `<Button>`, `<Select>` shadcn. Remplacer les `<details>` par des sections
   propres ou un `<Collapsible>` si shadcn en a un, sinon un état React simple.
4. **Responsive** : vérifier en largeur étroite que les tables et les grilles de
   formulaires (`md:grid-cols-4` sur analytics) ne débordent pas.
5. **`DashboardPageHeader`** partout pour l'unité des titres admin.
6. Décision `AppSidebar` dans l'admin : à arbitrer avec Robert — soit garder le
   header isolé (acceptable), soit un vrai `AdminSidebar`. Si pas tranché, garder
   l'isolement actuel et juste homogénéiser les composants.

> Volume estimé : c'est le plus gros ticket UI. Peut être découpé en 2 (tenants
> d'abord, analytics ensuite) si un agent UI préfère livrer par incréments.

## Fichiers concernés

- `app/dashboard/admin/tenants/page.tsx`
- `app/dashboard/admin/tenants/NotifuseAdminPanel.tsx`
- `app/dashboard/admin/page.tsx`
- `app/dashboard/admin/analytics/page.tsx`
- `app/dashboard/admin/layout.tsx`
- Composants shadcn déjà dispos : `table.tsx`, `select.tsx`, `input.tsx`,
  `button.tsx`, `alert-dialog.tsx`, `card.tsx`

## DoD

- [ ] `admin/tenants` utilise `<Table>` + `<Select>` + `<Input>` + `<Button>` shadcn
- [ ] Table tenants avec `overflow-x-auto` (pas de débordement mobile)
- [ ] `confirm()` natif remplacé par `<AlertDialog>`
- [ ] `admin/page.tsx` et `admin/analytics` en `<Card>` + formulaires shadcn
- [ ] `<DashboardPageHeader>` sur les 3 pages admin
- [ ] Aucun élément `<table>/<select>/<input>/<button>/<details>` natif restant
