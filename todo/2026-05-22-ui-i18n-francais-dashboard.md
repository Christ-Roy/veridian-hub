# UI — Uniformiser la langue du dashboard en français

> **Sévérité** : 🟡 P1 — incohérence produit visible sur tous les écrans connectés
> **Owner** : agent Hub
> **Créé** : 2026-05-22

## Contexte

Le produit Veridian est francophone : `lang="fr"` dans `app/layout.tsx`, landing
en français, pages légales en français, emails en français. Mais **les écrans
du dashboard mélangent français et anglais**, parfois dans le même composant.
C'est un signal d'amateurisme pour un user qui paie.

Inventaire (non exhaustif) :

- **`app/dashboard/page.tsx`** : titre "My Workspace", description "Your
  Veridian SaaS apps and tracking services in one place" — en anglais. Le reste
  de la page ("Vos SaaS", "Active chaque app...", "Comment ça marche") est en
  français.
- **`app/dashboard/billing/page.tsx`** : entièrement en anglais — "Billing",
  "Manage your subscription...", "Current Plan", "You are currently on...",
  "Manage Subscription", "No active subscription", "View pricing plans",
  "Started/Current period ends/Trial ends".
- **`app/dashboard/settings/page.tsx`** : mélange — "Settings", "Profile",
  "Security", "Account Information", "Danger Zone", "Member Since", "Email
  Verified", "Workspaces", "No workspaces configured yet" en anglais ; mais
  "Méthodes de connexion" en français.
- **`app/dashboard/components/ProspectionCard.tsx`** + **`TenantCard.tsx`** :
  CTA "Open Prospection" / "Open Notifuse", "Auto-login enabled", "Click to
  open your dashboard", "New login link will be generated", "Workspace", toasts
  "Failed to generate login link", "Error opening service" — anglais. Les blocs
  d'accroche ("Qualifie tes leads .fr...", "Essai gratuit 15 jours...") sont en
  français.
- **`app/dashboard/components/ServiceCard.tsx`** : CTA "Open", "Coming soon".
- **`components/app-sidebar.tsx`** : nav "Dashboard", "Billing", "Settings",
  "Get Help" en anglais, "Membres" en français. "Integration" + "Bientôt".
- **`app/dashboard/admin/*`** : mélange aussi (déjà partiellement en français).

## Travail à faire

1. **Trancher** : tout le dashboard en **français** (cohérent avec le reste du
   produit et la cible TPE/entrepreneurs FR).
2. Traduire systématiquement titres, descriptions, labels, boutons, toasts,
   états vides sur les pages dashboard listées ci-dessus. Garder les termes
   techniques propres (Stripe, OAuth, magic link) tels quels.
3. **Sidebar** : "Dashboard" → "Tableau de bord" (ou garder "Dashboard" si
   décision de garder l'anglicisme — mais alors cohérent partout), "Billing" →
   "Facturation", "Settings" → "Paramètres", "Get Help" → "Aide".
4. **Billing** : "Current Plan" → "Votre formule", "Manage Subscription" →
   "Gérer l'abonnement", dates ("Started" → "Démarré le", etc.).
5. Vérifier qu'aucun nouveau texte anglais ne traîne (`grep` rapide sur les
   chaînes type "Manage", "your", "Open ", "Coming").

> Pas besoin d'une lib i18n (next-intl) pour un produit mono-langue. Texte en
> dur en français suffit. Si une i18n est envisagée plus tard, ce sera un
> ticket séparé — ne pas sur-architecturer ici.

## Fichiers concernés

- `app/dashboard/page.tsx`
- `app/dashboard/billing/page.tsx`
- `app/dashboard/settings/page.tsx`
- `app/dashboard/components/ProspectionCard.tsx`
- `app/dashboard/components/TenantCard.tsx`
- `app/dashboard/components/ServiceCard.tsx`
- `app/dashboard/components/ShadowAppCard.tsx` ("Click pour en savoir plus")
- `components/app-sidebar.tsx` + `components/nav-secondary.tsx`

## DoD

- [ ] Tous les écrans `/dashboard/*` sont en français cohérent
- [ ] Aucun mix FR/EN dans un même composant
- [ ] Toasts en français
- [ ] La sidebar est cohérente (100 % FR ou décision tranchée et appliquée)
