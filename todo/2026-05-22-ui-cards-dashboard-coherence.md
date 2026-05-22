# UI — Cohérence des cards dashboard (icônes, modale, plan labels)

> **Sévérité** : 🟢 P2 — finition design system, un point pricing à surveiller
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : commits cards dashboard 73130a8 / 399a630, `docs/PRICING-VERIDIAN.md`

## Contexte

Les cartes d'apps du dashboard (`ProspectionCard`, `TenantCard`, `ServiceCard`,
`ShadowAppCard`) ont été livrées par incréments et présentent plusieurs
incohérences de finition. Le squelette `<Card>` shadcn est correct et les
tokens OKLCH sont respectés (audit précédent a nettoyé les couleurs) — mais le
détail diverge d'une carte à l'autre.

Constats :

1. **Deux styles d'icône d'app coexistent** :
   - `ProspectionCard` et `TenantCard` utilisent un **emoji** en gros (`🎯`,
     `📧`) dans un `<span className="text-2xl">`.
   - `ServiceCard` (Analytics, CMS actifs) utilise une **icône lucide** dans un
     conteneur `rounded-md bg-primary/10 p-2` — propre et cohérent avec le
     design system.
   → Les cartes principales (Prospection, Notifuse) ont l'air moins finies que
   les cartes secondaires. Harmoniser sur le pattern lucide + conteneur tinté.

2. **`ShadowAppModal` est une modale custom** : `app/dashboard/components/ShadowAppCard.tsx`
   réimplémente une modale à la main — `fixed inset-0`, `bg-black/60`
   (couleur hardcodée, non token), gestion du clic backdrop maison. Le projet a
   un `<Dialog>` shadcn (`components/ui/dialog.tsx`) — accessible (focus trap,
   Escape, `aria`), tokenisé. Remplacer la modale custom par `<Dialog>`.
   - Note : `bg-black/60` est la seule couleur hardcodée résiduelle trouvée
     dans tout le dashboard — la migrer vers `<Dialog>` la fait disparaître.

3. **Plan label Prospection vs pricing** : `ProspectionCard.tsx` calcule
   `planLabel = "Free (300 prospects)"`. Le doc `docs/PRICING-VERIDIAN.md`
   (philosophie figée par Robert) interdit les **compteurs visibles** et pose
   "tout illimité partout, seule différenciation = durée Free + white-label".
   Afficher "300 prospects" comme limite de plan dans l'UID Hub contredit cette
   ligne. Vérifier avec `docs/PRICING-VERIDIAN.md` la formulation correcte —
   probablement juste "Free" / "Pro" sans quota chiffré. Le texte d'accroche de
   la carte non-configurée dit aussi "300 prospects inclus" — même point.
   (À arbitrer : si le quota 300 est une réalité produit Prospection assumée,
   le formuler comme un argument et non comme une limite. Sinon, le retirer.)

4. **Mix FR/EN** dans ces cartes — traité par le ticket
   `2026-05-22-ui-i18n-francais-dashboard.md`, ne pas dédoubler ici. Mentionné
   pour mémoire : "Open Prospection", "Auto-login enabled", toasts EN.

5. **Badges incohérents** : `TenantCard` affiche `<Badge variant="success">✅
   Active</Badge>` — l'emoji ✅ dans un badge déjà coloré en vert est
   redondant. `ProspectionCard` affiche `<Badge variant="success">Active</Badge>`
   sans emoji — c'est la bonne version. Harmoniser (retirer l'emoji du badge
   TenantCard).

## Travail à faire

1. Harmoniser les icônes d'app : `ProspectionCard` + `TenantCard` passent au
   pattern icône lucide dans conteneur `bg-primary/10` (comme `ServiceCard`).
   Choisir des icônes lucide adaptées (`Target` pour Prospection, `Mail` pour
   Notifuse).
2. Remplacer la modale custom de `ShadowAppCard` par `<Dialog>` shadcn. Supprime
   le `bg-black/60` hardcodé.
3. Aligner les labels de plan sur `docs/PRICING-VERIDIAN.md` — retirer ou
   reformuler le "300 prospects" (compteur). Arbitrage à confirmer si besoin.
4. Retirer l'emoji ✅ du badge "Active" de `TenantCard`.

## Fichiers concernés

- `app/dashboard/components/ProspectionCard.tsx`
- `app/dashboard/components/TenantCard.tsx`
- `app/dashboard/components/ShadowAppCard.tsx`
- `app/dashboard/components/ServiceCard.tsx` (référence du bon pattern)
- `components/ui/dialog.tsx` (déjà dispo)

## DoD

- [ ] Toutes les cartes d'app utilisent le même style d'icône (lucide + conteneur tinté)
- [ ] `ShadowAppCard` utilise `<Dialog>` shadcn — plus de modale custom ni de `bg-black/60`
- [ ] Les labels de plan respectent `docs/PRICING-VERIDIAN.md` (pas de compteur chiffré)
- [ ] Badges "Active" cohérents entre toutes les cartes
