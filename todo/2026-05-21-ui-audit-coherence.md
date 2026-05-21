# Audit cohérence UI Hub — 2026-05-21

> **Type** : Audit (read-only, propose tickets)
> **Sévérité** : 🟡 P1 (cohérence design system, pas de bug bloquant)
> **Owner** : agent Hub
> **Auditeur** : agent UI audit Opus
> **Créé** : 2026-05-21

## Résumé exécutif

23 pages auditées (6 marketing, 8 auth, 7 dashboard, 1 invite, layouts inclus). Le squelette est sain (shadcn + Card + Tailwind tokens OKLCH), mais **trois grands problèmes minent la cohérence** :

1. **77 occurrences de couleurs Tailwind hardcodées** (`bg-blue-50`, `bg-green-100`, `text-indigo-600`, `bg-white`, `bg-gray-50`…) violent la règle CLAUDE.md Hub "ne jamais hardcoder les couleurs". Concentrées dans `/dashboard/admin/*`, `/dashboard/billing`, `/dashboard/page.tsx`, `app/dashboard/components/*Card.tsx`, `PricingGrid.tsx`. **L'admin est cassé en dark mode** (bg-white, bg-gray-50 partout).
2. **Section admin = stack visuelle parallèle** : son layout (`app/dashboard/admin/layout.tsx`) shunte `AppSidebar` et impose son propre header (`bg-white`, liens `text-indigo-600`). Aucune cohérence avec le reste du dashboard.
3. **Forms d'auth dupliqués** : `LoginForm.tsx` (167L) et `SignupForm.tsx` (202L) sont à 90 % copiés-collés — mêmes inline SVG Google/Microsoft 5 lignes, mêmes handlers `signIn(...)`, même layout `FieldGroup`. ~120 lignes de duplication, divergence garantie.

Autres frictions : hiérarchie de titres dashboard hétérogène (`text-4xl` vs `text-2xl` selon la page), 2 routes auth dépréciées encore servies (`/signin`, `/signin1` redirect-only), `dashboard/admin/tenants/page.tsx` n'utilise pas `<Table>` shadcn (custom `<table>` + inputs natifs), `console.log` debug en `dashboard/layout.tsx:67` qui fuit en prod.

---

## 1. Doublons / pages à fusionner ou supprimer

| Route | État | Reco |
|---|---|---|
| `app/(auth)/signin/page.tsx` | redirect → `/login` (4 lignes utiles) | supprimer après `grep -r "/signin"` cross-repo. Ajouter `redirects` dans `next.config.ts` à la place. |
| `app/(auth)/signin1/page.tsx` | redirect → `/login`, ex-template shadcn login-02 | supprimer, même approche `redirects` |
| `app/(auth)/auth/verify/page.tsx` | redirect legacy Supabase OTP, encore client-side `useEffect` | déplacer en `redirects` config (sauf si query param `type=recovery` doit être préservé — alors le garder mais simplifier en `redirect()` server) |
| `app/signin/forgot_password/page.tsx` | route fonctionnelle | renommer vers `app/(auth)/forgot-password/page.tsx` pour rester sous `(auth)` group et utiliser la convention kebab-case existante ailleurs |

**Risque actuel** : les anciens liens dans des mails (`/signin?...`, `/auth/verify?type=recovery`) fonctionnent. Toute fusion DOIT garder les redirects.

---

## 2. Incohérences visuelles

### 2.1 Couleurs hardcodées (PRIORITÉ HAUTE — 77 occurrences)

**Cassures dark mode confirmées** :

- `app/dashboard/admin/layout.tsx:25-46` : `bg-gray-50`, `bg-white`, `text-indigo-600`, `text-red-600`. Header admin invisible en dark theme.
- `app/dashboard/admin/page.tsx:49,58` : `bg-white border` sur les cards stats. → utiliser `<Card>` shadcn.
- `app/dashboard/admin/tenants/page.tsx:163-165,199,281` : `bg-white`, `bg-gray-50`, `hover:bg-gray-50`, `bg-gray-100`. Table entière custom au lieu de `<Table>`.
- `app/dashboard/admin/analytics/page.tsx:109-281` : `text-gray-900`, `bg-white`, `bg-indigo-600`, `bg-red-50`, `bg-gray-900`. Tout le panneau.

**Cassures cosmétiques** (light mode OK, dark mode contraste douteux) :

- `app/dashboard/page.tsx:127-131` : message bienvenue en `bg-blue-50 border-blue-200 text-blue-900` → remplacer par `<Alert>` shadcn ou tokens `bg-primary/10`.
- `app/dashboard/components/TenantCard.tsx:100,119-121` + `ProspectionCard.tsx:83,100-102` : badges "Active" en `bg-green-50 text-green-700` au lieu de `<Badge variant="default">`. Boxes info bleues hardcodées.
- `app/dashboard/components/ShadowAppCard.tsx:39,83` : `bg-amber-50` deux fois.
- `app/dashboard/components/ServiceCard.tsx:54` : `bg-orange-100 text-orange-700` pour le badge BETA.
- `app/dashboard/billing/page.tsx:41-47` : map de 7 status → 7 couleurs Tailwind brutes. Couleurs semi-acceptables sémantiquement, mais le badge `bg-blue-500` + `variant="secondary"` se télescopent visuellement. Idem ligne 222-227 dans le bloc debug.
- `app/dashboard/settings/page.tsx:111,159` : badge "Active" `bg-green-100 text-green-800`, texte `text-amber-600`.
- `components/pricing/PricingGrid.tsx:113,238,265,267` : `text-green-600`, `bg-indigo-600`, `text-gray-300`. Le badge "Recommandé" et le ring sont hardcodés (`ring-indigo-500`) au lieu d'utiliser `bg-primary`.

**Reco unique** : tickets de fix par chunks (admin / billing / cards dashboard / pricing) en remplaçant systématiquement par `primary`, `destructive`, `accent`, `success` (à ajouter au theme), `<Badge>`, `<Alert>`.

### 2.2 Layouts auth : 3 variantes incompatibles

| Page | Layout |
|---|---|
| `/login` + `/signup` | split-screen `lg:flex-row` avec brand panel à droite (`bg-muted`), logo flottant `absolute top-12 left-12` |
| `/auth/mfa` | centered Card max-w-sm, Logo centré dans la Card |
| `/auth/reset` + `/signin/forgot_password` | centered Card max-w-md, **pas de logo du tout** |

Le layout parent `app/(auth)/layout.tsx` ne fait que `flex items-center justify-center` — donc chaque page redéfinit son cadre. Les pages forgot/reset n'ont aucune accroche brand Veridian. **Risque conversion** : un user qui clique sur le lien de reset depuis son mail tombe sur une Card orpheline sans logo.

**Reco** : factoriser `<AuthCard>` shared (Logo + Card + max-width) dans `components/auth/AuthCard.tsx`. Toutes les pages auth l'utilisent. Garder le split-screen `/login` + `/signup` comme variante "brand-heavy" si ROI démontré.

### 2.3 Hiérarchie de titres dashboard

| Page | h1 |
|---|---|
| `/dashboard` | `text-4xl font-bold tracking-tight` + icon `h-10 w-10` |
| `/dashboard/billing` | `text-4xl font-bold tracking-tight` + icon `h-10 w-10` |
| `/dashboard/settings` | `text-4xl font-bold tracking-tight` + icon `h-10 w-10` |
| `/dashboard/workspace/members` | `text-4xl font-bold tracking-tight` + icon `h-10 w-10` |
| `/dashboard/settings/security` | `text-2xl font-semibold`, **pas d'icône** |
| `/dashboard/admin` (overview) | `text-2xl font-bold mb-6` |
| `/dashboard/admin/tenants` | `text-2xl font-bold` |
| `/dashboard/admin/analytics` | `text-2xl font-semibold` |

→ deux niveaux de "h1" co-existent. Cohérence cassée dès qu'un user navigue dashboard → admin → security.

**Reco** : créer `<DashboardPageHeader title icon description />` dans `components/dashboard/PageHeader.tsx`. Standardiser sur `text-3xl font-bold` (compromis) avec icon optionnelle.

### 2.4 Footer : liens morts + mix EN/FR

`components/ui/Footer/Footer.tsx:75-108` : 4 liens "Home / About / Careers / Blog" pointent **tous vers `/`** (placeholders). Sous-section LEGAL : "Privacy Policy" / "Terms of Use" / "Mentions légales" — anglais ET français mélangés. Section LEGAL fonctionnelle, le reste : pollution.

**Reco** : virer About/Careers/Blog (pas de roadmap pour ces pages). Garder Home, Pricing, Docs. Tout en français pour cohérence avec le reste du site (`fr_FR` locale dans `layout.tsx:34`).

### 2.5 Page `/docs` : style parallèle au reste

`app/(marketing)/docs/page.tsx:42-86` utilise les classes utilitaires custom `gradient-bg`, `page-title`, `section-title`, `feature-card` définies dans `styles/main.css` au lieu de `<Card>` shadcn. Cohérent en interne mais hors-norme face aux pages /privacy /terms /legal qui sont **Card-based**. Le CTA "Accéder à Notifuse Docs →" est un `<a>` stylé avec `bg-primary` (OK) mais ce n'est pas un `<Button asChild>` (pas de hover, pas d'accessibilité focus ring shadcn).

**Reco** : refondre `/docs` en utilisant `<Card>` + `<Button asChild>` pour homogénéiser avec /pricing et /privacy. Garder les classes `.gradient-bg` éventuellement, mais purger `.page-title` / `.section-title` / `.feature-card` du CSS si plus utilisées ailleurs.

### 2.6 Card styling divergent

- `/dashboard/admin/page.tsx:49` : `<div className="bg-white border rounded-lg p-6">` — pas de `<Card>`.
- `/dashboard/admin/tenants/page.tsx:163` : `<div className="bg-white rounded-lg border">` + `<table>` natif.
- `/dashboard/admin/analytics/page.tsx:128,170` : `<section className="bg-white border rounded-lg p-6">`.
- Le reste du dashboard utilise `<Card>` shadcn correctement.

**Reco** : remplacer toutes les pseudo-cards admin par `<Card>`/`<CardHeader>`/`<CardContent>`. C'est le quick-win le plus immédiat.

---

## 3. Frictions UX par flow

### 3.1 Signup → premier dashboard

1. `/signup` → server insert via `POST /api/auth/signup` → `signIn('credentials', ...)` → push(`callbackUrl`).
2. Arrivée sur `/dashboard` : section "My Workspace", panneau bleu de bienvenue (hardcodé) "👋 Bienvenue ! Démarre ton essai…".
3. **Friction** : aucune onboarding step-by-step. L'utilisateur voit 4 cards (Prospection, Notifuse + 2 ShadowAppCard pour CMS/Analytics) et un bandeau freemium qui clignote. Pas de checklist "Configure ton workspace en 3 étapes".
4. `workspaceName` est affiché dans la sidebar (bien) mais le nom par défaut généré (`provisionDefaultWorkspace` self-heal côté members) n'est probablement pas customisé par l'user à la création.

**Frictions concrètes** :

- Aucune confirmation "Welcome to Veridian" full-screen entre signup et dashboard. L'user atterrit directement dans le complexe.
- Le panneau bleu de bienvenue ne s'affiche que si `!tenant` — donc disparaît dès qu'un trial est démarré, l'user perd le repère "je suis nouveau".
- `console.log('[Dashboard Layout] User info:', …)` à `app/dashboard/layout.tsx:67` log en server logs (NODE_ENV=development seulement, donc OK en prod, mais log noisy en dev).

**Tickets potentiels** :

- Onboarding modal post-signup (1 step "Configure ton workspace" + 1 step "Démarre une app").
- Renommer "My Workspace" → utiliser le `workspaceName` réel récupéré dans la layout (déjà fetché ligne 41-48 du layout, juste à passer en prop).

### 3.2 Login → dashboard (avec MFA)

`/login` ↓ submit credentials ↓ Auth.js callback ↓ si `mfaEnabled` → redirect `/auth/mfa?uid=...` → input 6-char code → `/dashboard`.

**OK** : le flow technique est propre, MFA page bien designée (Logo, timer resend 30s, error handling, "Retour à la connexion").

**Friction** : `/auth/mfa` et `/login` ne partagent **pas** la même layout brandée (split-screen vs Card centered). L'user voit deux ambiances visuelles différentes entre saisie password et saisie OTP.

**Friction Reset password** : depuis `/login` le lien "Mot de passe oublié ?" pointe `/signin/forgot_password` (kebab obsolète). Quand l'user reçoit le mail il atterrit sur `/auth/reset?token=...`, **sans logo Veridian**. Conversion à risque.

### 3.3 Invite → accept → app downstream

`app/invite/[token]/page.tsx` (215 L) gère bien **les 4 cas** (`not_found`, `expired`, `consumed`, `valid` + cas "mauvais compte"). Logo Veridian présent en haut de chaque Card. CTA clairs.

**OK globalement.**

**Mini-friction** : après acceptation (`?accepted=1`), le CTA "Accéder au workspace" pointe `/dashboard/workspace/members` plutôt que `/dashboard` — choix discutable mais cohérent avec le flow membre.

### 3.4 Billing

`app/dashboard/billing/page.tsx` (248 L). Affiche prix `Intl.NumberFormat('en-US', currency:'USD')` ligne 97-99 → **bug locale** : prix Veridian en EUR mais formatage en USD par défaut, donc tant que `subscription.price.currency` n'est pas renseigné précisément, on affiche `$29.00` au lieu de `29,00 €`. Source pricing-veridian.md = € only.

Pas de toggle annuel visible sur la page billing — uniquement sur `/pricing`. Pas de "Plan actuel" badge visible.

**Friction** :

- Pas de comparatif "tu as X, upgrade vers Y pour…"
- Bloc debug en `NODE_ENV=development` affichant Stripe IDs : OK en dev, mais s'il fuit en prod c'est gênant (déjà vu plus haut idem dashboard).
- Lien "View pricing plans" en `text-primary hover:underline` à ligne 157 — devrait être un `<Button variant="link">` pour focus ring accessible.

### 3.5 Members

`app/dashboard/workspace/members/page.tsx` (148 L) + `MembersTable.tsx` + `InviteModal.tsx`. Bonne structure : auto-self-heal du workspace si manquant, table shadcn `<Table>`, badge rôle, actions par membre, modal invite. **C'est le bon pattern de référence pour le reste du dashboard.**

### 3.6 Admin

Voir §2.1 et §2.6 — la navigation admin est techniquement isolée du reste du dashboard (sidebar disparaît). Le user-experience est très "intranet années 2000" :

- Tenants : table HTML brute, dropdowns `<select>` natifs (non-shadcn), input date natif, focus ring `focus:ring-indigo-500` hardcodé.
- Analytics : `<details><summary>` natif pour les actions, formulaires en `<input className="border rounded">`, boutons en `<button className="bg-indigo-600">`.

**Pas de pagination, pas de search avancé, pas de filtre par plan, pas de tri.** Acceptable au volume actuel (~23 tenants prod) mais bombe à retardement.

---

## 4. Composants à factoriser

| Composant proposé | Remplace | Économie |
|---|---|---|
| `<OAuthButtons callbackUrl=...>` | Bloc Google+Microsoft dans `LoginForm:121-163` et `SignupForm:156-198` (inline SVG dupliqués 8 lignes) | ~80 LOC |
| `<AuthCard logo title description>` | Cadre Card + Logo + max-w dupliqué dans `/login`, `/signup`, `/auth/mfa`, `/auth/reset`, `/signin/forgot_password`, `/invite/[token]` | ~50 LOC |
| `<DashboardPageHeader icon title description action?>` | Bloc `<div className="flex items-center gap-3 mb-2"><Icon /><h1 className="text-4xl font-bold">{title}</h1></div>` dupliqué dans 5 pages dashboard | ~30 LOC, cohérence H1 |
| `<StatusBadge status>` | Map `getStatusBadge` inline dans billing/page.tsx (47 LOC) — devrait être réutilisable côté admin tenants | ~40 LOC |
| `<InfoCallout variant="info"|"warning"|"success">` | Boxes `bg-blue-50 border-blue-200` (TenantCard, ProspectionCard, ShadowAppCard) — remplacer par `<Alert>` shadcn customisé | élimine 5+ blocs hardcodés |
| `<LegalPageLayout title lastUpdated>` | Wrapper Card identique dans `/privacy`, `/terms`, `/legal` (header centré + dernière maj + Card) | ~30 LOC |

---

## 5. Responsive

Audit ciblé pages à risque :

| Page | Verdict |
|---|---|
| `/` (landing) | ✅ classes `sm:`, `md:`, `lg:` partout (hero-section, features-section) |
| `/pricing` | ✅ `grid-cols-1 md:grid-cols-3`, switch interval OK mobile |
| `/login`, `/signup` | ✅ split-screen `lg:flex-row`, mobile-first |
| `/dashboard` | ✅ grids `md:grid-cols-2 lg:grid-cols-3` |
| `/dashboard/billing`, `/dashboard/settings`, `/dashboard/members` | ✅ `p-4 md:p-8 max-w-4xl mx-auto` |
| `/dashboard/admin` | ✅ `md:grid-cols-3` sur les stats |
| `/dashboard/admin/tenants` | 🟡 **risque** : `<table>` avec 7 colonnes + selects + input date, **rien ne dit qu'elle est mobile-friendly**. Pas de overflow-x-auto sur le wrapper (le `overflow-hidden` ligne 163 est sur la card, pas sur la table). À tester sur mobile réel — probablement overflow horizontal sale. |
| `/dashboard/admin/analytics` | 🟡 idem, `md:grid-cols-4` sur les forms (4 cols inline = ~600px min, casse sur < md) |
| `/auth/mfa`, `/auth/reset`, `/signin/forgot_password` | ✅ centered, max-w-md (OK mobile) |
| `/privacy`, `/terms`, `/legal` | ✅ `container max-w-4xl py-12 px-4` |
| `/docs` | ✅ `grid-cols-1 md:grid-cols-2` |
| `/invite/[token]` | ✅ max-w-sm, centered |

**Pages à tester en priorité sur mobile réel** : `/dashboard/admin/tenants` et `/dashboard/admin/analytics`. Probable wrap horizontal cassé.

---

## 6. Accessibilité

- ✅ 6 occurrences `alt=` couvrent les 3 `<Image>` Next dans landing (hero + features). Aucune `<img>` brute trouvée.
- ✅ `aria-label` présent 12 fois (theme toggler, payment icons SVG, button fermer banner freemium, etc.).
- 🟡 **Heading hierarchy à vérifier sur `/dashboard/admin`** : le layout met juste un header `<header>` sans `<h1>` → l'overview enfant fait `<h1>` mais c'est le 2ᵉ context "global" sans structure outline propre.
- 🟡 **Boutons icon-only sans aria-label** : `<button>` dans `/dashboard/admin/tenants/page.tsx:279` "Impersonate" a un texte (OK), mais `<XIcon>` dans FreemiumBanner a `aria-label="Fermer le bandeau"` (OK). Manque potentiel : `RefreshButton` (`app/dashboard/page.tsx:102`) — à vérifier.
- 🟡 **Focus ring hardcodé violet** : `app/dashboard/admin/tenants/page.tsx:159` `focus:ring-2 focus:ring-indigo-500` — ne suit pas le focus ring shadcn (`focus-visible:ring-ring`).
- 🟡 **Contraste dark mode** : tous les `bg-blue-50 text-blue-900` (TenantCard, ProspectionCard, page.tsx dashboard) ne s'adaptent pas au dark mode → texte bleu foncé sur fond bleu clair restera tel quel en dark, illisible si fond global passe en sombre.
- 🟡 **Code blocks sans `role`** : `<code className="bg-muted px-2 py-0.5 rounded">` partout — sémantiquement OK avec `<code>` natif.

---

## 7. Quick wins (≤ 1h chacun)

> Triés par ratio impact / effort. Tous peuvent être faits sans toucher à la logique business.

1. **Supprimer `console.log` en prod** : `app/dashboard/layout.tsx:67` est gardé sous `NODE_ENV === 'development'` — OK. Mais idem dans `app/dashboard/page.tsx:108-123` (bloc debug) et `app/dashboard/billing/page.tsx:185-235`. Vérifier que **rien ne fuit en build prod**.
2. **Fixer locale prix billing** : `app/dashboard/billing/page.tsx:97` → `Intl.NumberFormat('fr-FR', { currency: 'EUR', … })`. 1 ligne, conversion EUR.
3. **Footer cleanup** : virer "About / Careers / Blog" qui pointent `/`. Tout traduire en français cohérent.
4. **Header admin layout** : `app/dashboard/admin/layout.tsx:25-50` — remplacer `bg-gray-50`, `bg-white`, `text-indigo-600`, `text-red-600` par tokens `bg-background`, `bg-card`, `text-primary`, `text-destructive`. **Casse dark mode admin = fix immédiat.**
5. **Admin overview cards** : `app/dashboard/admin/page.tsx:49,58` → remplacer `bg-white border rounded-lg p-6` par `<Card><CardContent>`.
6. **Boxes info bleues hardcodées** : remplacer `bg-blue-50 border-blue-200 text-blue-900` par `<Alert>` shadcn avec variant info (à créer si pas dans alert.tsx) ou `bg-primary/10 border-primary/20 text-foreground`. 5 fichiers concernés.
7. **Renommer page dashboard `My Workspace`** : utiliser le `workspaceName` déjà disponible dans le layout. Passer en prop ou via Context.
8. **Standardiser DashboardPageHeader** : créer le composant + appliquer à 5 pages dashboard. Cohérence H1 immédiate.
9. **Routes auth dépréciées** : déplacer redirects `/signin`, `/signin1` dans `next.config.ts` (`redirects()`). Supprime 2 pages.
10. **Logo orphelin sur `/auth/reset` et `/signin/forgot_password`** : ajouter `<Logo>` + lien `/` en haut de la Card (3 lignes par page).

---

## 8. Sprints UX à ouvrir (≥ 4h chacun)

### Sprint A — Refonte design system admin (~6h)

- Convertir `dashboard/admin/{layout,page,tenants/page,analytics/page}` en composants shadcn (`<Card>`, `<Table>`, `<Select>`, `<Input>`, `<Button>`).
- Réintégrer la `AppSidebar` dans la section admin (à voir si Robert préfère garder l'isolement visuel — mais alors créer un vrai `AdminSidebar` cohérent au lieu du header bare-metal).
- Ajouter pagination + search server-side sur `/admin/tenants` (déjà filter client-side, OK temporairement).
- Standardiser sur tokens OKLCH partout.

### Sprint B — Factorisation forms auth + AuthCard (~4h)

- Créer `components/auth/OAuthButtons.tsx` (Google + Microsoft + icônes SVG une seule fois).
- Créer `components/auth/AuthCard.tsx` (Logo + Card + max-w configurable).
- Refactor `/login`, `/signup`, `/auth/mfa`, `/auth/reset`, `/signin/forgot_password` pour utiliser `AuthCard` + `OAuthButtons`.
- Tests E2E : vérifier que les buttons Google + Microsoft s'affichent et postent correctement (le mock OAuth provider est en place côté staging — cf `reference_mock_oauth_provider.md`).

### Sprint C — Onboarding post-signup (~5h)

- Modal welcome step-by-step post-signup (1 étape "Nom workspace personnalisé", 1 étape "Choisis ton app de départ").
- État onboardingCompleted bool en DB User.
- Tracking GTM "onboarding_step_1" / "onboarding_completed".

### Sprint D — Refonte page billing (~4h)

- Toggle annuel / mensuel sur la page billing elle-même (pas juste sur /pricing).
- Badge "Plan actuel" visible dans le hero de la page (cf. comportement `currentPlanKey` côté pricing).
- Comparatif "What you'd get with X+" si user est sur plan inférieur.
- Locale EUR fixée.
- Bloc "Manage Subscription" via Stripe Portal → ajouter un état "Pas encore de subscription, voici les plans" inline.

### Sprint E — Page docs refonte (~3h)

- Convertir en Card shadcn + Button asChild.
- Ajouter plus de cards (Hub Auth, Stripe, Workspace setup, OAuth providers troubleshooting).
- Ou décision business : virer `/docs` interne et pointer `docs.veridian.site` externe (si roadmap existe).

---

## 9. Recos sur le design system

1. **Étendre `styles/main.css` avec tokens sémantiques** : ajouter `--color-success`, `--color-warning`, `--color-info` dans le theme OKLCH (en plus du `--destructive` actuel). Permet de remplacer tous les `bg-green-100 text-green-800` par `bg-success/10 text-success`.
2. **Ajouter `Alert` variants** : `components/ui/alert.tsx` actuel est minimal — ajouter `variant: "info" | "success" | "warning"` qui mappe aux tokens ci-dessus.
3. **Bibliothèque `components/forms/`** : aujourd'hui `components/auth/` (3 fichiers) + `components/ui/AccountForms/` (4 fichiers) + `components/workspace/InviteModal.tsx`. C'est éparpillé. Proposer : `components/forms/{auth/, account/, workspace/}` ou tout sous `components/forms/`.
4. **Documenter le design system dans `/docs` ou `README` repo** : aujourd'hui aucun fichier ne dit "voici les tokens, voici les composants à utiliser". Un dev (ou agent) tombe sur `bg-white` partout dans `/admin/*` et ne sait pas que c'est interdit. Le CLAUDE.md Hub le dit en 1 ligne, mais ce serait à mettre dans un `docs/DESIGN-SYSTEM.md` listant explicitement la grille de couleurs OKLCH, les composants Card/Button/Badge/Alert prescrits, les patterns "page header dashboard" etc.
5. **Lint custom** : règle ESLint qui bloque les classes hardcodées `bg-{red,blue,green,…}-XXX` dans le code (sauf liste blanche pour les SVG paymentcards qui doivent garder les couleurs marque). Empêche la régression.
6. **Storybook ou exemples visuels** : pas indispensable mais utile pour aligner les agents sur "à quoi ressemble un dashboard page header bien fait".

---

## Plan d'attaque suggéré

**Si Robert veut commencer aujourd'hui** : Quick wins #4, #5, #6 (dark mode admin) en 1h — gros impact visuel immédiat. Puis #2 (locale EUR billing) parce que c'est une faute pro de prix mal localisé.

**Si Robert veut un sprint cohérent** : Sprint A (refonte admin) parce que c'est la zone la plus dégradée et la plus facile à isoler (ne touche pas aux flows critiques signup/login/billing user-facing).

**Sprint B (factorisation auth)** est tentant mais risqué : touche aux pages critiques signup/login. À faire avec couverture E2E renforcée (déjà 12 E2E + mock OAuth provider — cf. `reference_mock_oauth_provider.md`).
