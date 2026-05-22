# UI — Onboarding du premier dashboard (post-signup / workspace auto-create)

> **Sévérité** : 🟡 P1 — friction de conversion sur le moment le plus important du funnel
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : commit workspace auto-create 29737a4 (`todo/done/2026-05-21-workspace-provisioning-at-signup.md`)

## Contexte

Le workspace est désormais auto-créé au signup (commit 29737a4). Mais
**l'expérience du tout premier dashboard n'a pas été pensée** : un user qui
vient de s'inscrire atterrit directement sur l'écran complet, dense, sans
accompagnement.

État actuel (`app/dashboard/page.tsx`) :

- Un user neuf voit immédiatement : 2 cartes app actives (Prospection,
  Notifuse), 2 `ShadowAppCard` (CMS, Analytics, grisées), une section "Comment
  ça marche", et un bandeau freemium. C'est beaucoup d'un coup.
- Le seul repère "tu es nouveau" est une `<Alert variant="info">` "👋
  Bienvenue ! Démarre ton essai gratuit..." — **rendue uniquement si
  `!tenant`**. Dès qu'un trial est démarré sur une app, le repère disparaît,
  alors que l'user reste un nouvel utilisateur sur tout le reste.
- Le titre de la page est **"My Workspace"** en dur, alors que le vrai
  `workspaceName` du user est déjà fetché dans `app/dashboard/layout.tsx`
  (ligne 63, `currentWorkspaceName`) et passé à la sidebar — il n'est juste pas
  utilisé sur la page elle-même.
- Aucune étape guidée : pas de checklist "Configure ton workspace", pas de
  next-step clair après le signup.
- Section "Apps réservées clients sites vitrines" avec 2 `ShadowAppCard`
  grisées en `opacity-60` : pour un nouvel user, voir 2 apps grisées sans
  contexte fort peut ressembler à des features bridées (à border de
  l'interdit "menu grisé" du doc pricing — ici c'est un upsell légitime, mais
  la présentation mérite d'être soignée pour ne pas donner cette impression).

## Travail à faire

1. **Titre de page dynamique** : remplacer "My Workspace" en dur par le nom réel
   du workspace. Le layout fetch déjà `currentWorkspaceName` — le passer en
   prop / contexte jusqu'à la page, ou refetch dans la page.
2. **Repère "premier pas" persistant** : un user neuf doit avoir une zone
   d'accueil qui ne disparaît pas au premier trial démarré. Option simple :
   un état `onboardingCompleted` (bool sur `User`) ou une heuristique "aucune
   app encore réellement utilisée". Tant que pas complété, afficher une
   checklist courte :
   - [ ] Démarre ta première app (Prospection ou Notifuse)
   - [ ] (optionnel) Invite un membre dans ton workspace
   - [ ] (optionnel) Personnalise le nom de ton workspace
3. **Personnalisation du nom du workspace** : le nom par défaut généré au
   provisioning (`provisionDefaultWorkspace`) n'est jamais customisé par l'user.
   Offrir un point d'entrée pour le renommer (inline edit dans le header de
   page, ou via Settings).
4. **Soigner la section "Apps réservées sites vitrines"** : clarifier que ce
   sont des apps incluses dans une autre offre (upsell), pas des features
   bridées de la formule courante. Le wording actuel est correct, mais
   l'`opacity-60` + `border-dashed` peut suggérer "bloqué". Revoir le
   traitement visuel pour que ça lise "découvre cette offre" et non "feature
   verrouillée".
5. **Pas de modal lourde imposée** : un onboarding inline (checklist sur la
   page) est préférable à une modale plein écran bloquante. Garder léger.

## Fichiers concernés

- `app/dashboard/page.tsx`
- `app/dashboard/layout.tsx` (passe déjà `currentWorkspaceName`)
- `app/dashboard/components/ShadowAppCard.tsx` (traitement visuel upsell)
- éventuellement `prisma/schema.prisma` si un champ `onboardingCompleted` est
  retenu — dans ce cas migration versionnée (coordonner, c'est un changement DB)

## DoD

- [ ] La page dashboard affiche le vrai nom du workspace, pas "My Workspace"
- [ ] Un user neuf a un repère d'accueil qui ne disparaît pas au premier trial
- [ ] Une checklist / next-step claire est visible tant que l'onboarding n'est
      pas complété
- [ ] Le user peut renommer son workspace
- [ ] La section apps sites vitrines ne se lit pas comme des features bridées
