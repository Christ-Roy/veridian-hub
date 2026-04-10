# Hub — UI Review queue (solo polish)

> File d'attente de polish UI pour Robert en session standalone, hors sprint.
> Chaque nouvelle page ou composant livre par un agent team = une entree ici.
>
> **Workflow** :
> 1. Lire les entrees non cochees en ordre
> 2. `cd hub && npm run dev` (localhost:3000)
> 3. Naviguer vers l'URL, tester, polish avec Next dev
> 4. Commit direct sur `staging` (ou PR si gros changement)
> 5. Cocher l'entree, la deplacer en bas dans "Reviewed"
>
> **Conventions** :
> - Badge Veridian : couleurs du design system (voir `hub/app/globals.css`)
> - Typo : Inter pour le corps, taille consistante (text-sm par defaut)
> - Spacing : p-4/p-6 pour les cards, gap-4 pour les flex
> - Responsive : tester mobile (375px) et desktop (1440px)

---

## A reviewer

### [2026-04-10] Page membres workspace + modal invitation
- **Contexte** : livre par hub-members-builder dans sprint P1.5
- **URL dev** : http://localhost:3000/dashboard/workspace/members
- **URL staging** : https://saas-hub.staging.veridian.site/dashboard/workspace/members
- **Fichiers** :
  - `hub/app/dashboard/workspace/members/page.tsx`
  - `hub/components/workspace/MembersTable.tsx`
  - `hub/components/workspace/InviteModal.tsx`
  - `hub/components/workspace/MemberActions.tsx`
- **A polish** :
  - [ ] Alignement colonnes du tableau (role badge, date, actions)
  - [ ] Modal InviteModal : vérifier spacing input + select + boutons
  - [ ] Bouton "Inviter un membre" : couleur Veridian primary
  - [ ] Responsive mobile : tableau scrollable horizontalement ?
  - [ ] Loading state MemberActions (spinner pendant le changement de rôle)
  - [ ] Empty state quand 0 membres (actuellement un simple texte)
  - [ ] Bandeau "Mode démo" : couleur/style cohérent avec le design system
  - [ ] Avatar initiales : fond cohérent avec les couleurs Veridian
- **Notes agent** : En mode démo (PRISMA_READY=false), données fictives. Activer
  Prisma pour voir le vrai flux. La AlertDialog de suppression membre est à
  vérifier sur mobile (modale centrée OK ?). Le select de changement de rôle
  est en w-36, à ajuster si les labels traduits sont plus longs.

### [2026-04-10] Page MFA email /auth/mfa (P1.4)
- **Contexte** : livre par hub-auth-builder dans sprint P1.4
- **URL dev** : http://localhost:3000/auth/mfa?uid=test123 (nécessite un uid en query)
- **URL staging** : https://saas-hub.staging.veridian.site/auth/mfa
- **Fichiers** :
  - `hub/app/auth/mfa/page.tsx`
- **A polish** :
  - [ ] Card centrée : le min-h-screen flex items-center est OK sur desktop, à vérifier mobile
  - [ ] Input code : tracking-[0.5em] peut sembler large, ajuster si moche
  - [ ] Logo en haut de la card : cohérent avec /login ?
  - [ ] Bouton "Valider" disabled state (couleur trop pale ?)
  - [ ] Message d'erreur : couleur destructive, voir si lisible en dark mode
  - [ ] Compteur resend "dans Xs" : position/taille
  - [ ] État "session expirée" (pas de uid) : design de la card
  - [ ] Responsive mobile : padding p-6 OK ?
- **Notes agent** : aucun Playwright dans le hub, donc pas de screenshot e2e.
  Le flow complet est : Google OAuth → signIn callback → issueAndSendMfaCode
  → redirect vers cette page → user tape code → POST /api/auth/mfa/verify
  → cookie mfa_passed_<uid> → relance signIn → session créée (3 mois cookies).

### [2026-04-10] Page settings/security (toggle 2FA) (P1.4)
- **Contexte** : livre par hub-auth-builder dans sprint P1.4
- **URL dev** : http://localhost:3000/dashboard/settings/security
- **URL staging** : https://saas-hub.staging.veridian.site/dashboard/settings/security
- **Fichiers** :
  - `hub/app/dashboard/settings/security/page.tsx` (server component)
  - `hub/app/dashboard/settings/security/SecurityMfaToggle.tsx` (client)
- **A polish** :
  - [ ] Card width max-w-2xl : OK ou trop large ?
  - [ ] Hiérarchie h1 "Sécurité" → h2 "Validation par email" → body
  - [ ] Bouton toggle : variant outline quand actif / default quand inactif — inverser ?
  - [ ] Message "Activée / Désactivée" : couleur ou badge ?
  - [ ] Font-mono sur l'email : approprié ou trop technique ?
  - [ ] Message erreur (toggle failed) : position / style
  - [ ] Ajouter un fil d'ariane (Dashboard / Settings / Security) ?
  - [ ] Lien vers d'autres paramètres sécurité (à venir : password reset, etc.)
- **Notes agent** : nécessite une session Auth.js pour afficher la page
  (server component qui call `auth()`). En dev, brancher la DB Postgres
  (DATABASE_URL) sinon Prisma throw. La page UI legacy Supabase Auth
  continue de fonctionner en parallèle — pas de conflit.

### [2026-04-10] Page acceptation invitation /invite/[token]
- **Contexte** : livre par hub-members-builder dans sprint P1.5
- **URL dev** : http://localhost:3000/invite/demo (token "demo" = démo hardcodée)
- **URL staging** : https://saas-hub.staging.veridian.site/invite/[token]
- **Fichiers** :
  - `hub/app/invite/[token]/page.tsx`
  - `hub/app/invite/[token]/AcceptInviteButton.tsx`
- **A polish** :
  - [ ] Logo centré + espacement avec la card
  - [ ] Icônes de status (Check, X, Clock) : taille et couleurs OK ?
  - [ ] Bouton "Accepter l'invitation" : full width, couleur Veridian
  - [ ] Page "Mauvais compte" : layout compact, lisible
  - [ ] Page "Invitation expirée/introuvable" : CTA clair vers login ou dashboard
  - [ ] Test token "demo" pour voir le flow complet en mode démo
- **Notes agent** : Toutes les variantes de token (valid/expired/consumed/not_found/
  wrong_account) sont implémentées. En mode démo, seul le token "demo" fonctionne.

**Format d'une entree** (copier-coller par les agents) :

```markdown
### [YYYY-MM-DD] Nom de la page ou du composant
- **Contexte** : livre par team lead dans sprint P1.X
- **URL dev** : http://localhost:3000/path
- **URL staging** : https://saas-hub.staging.veridian.site/path
- **Fichiers** : `hub/app/path/page.tsx`, `hub/components/X.tsx`
- **A polish** :
  - [ ] Alignement padding/spacing
  - [ ] Couleurs boutons (primary Veridian)
  - [ ] Responsive mobile
  - [ ] Loading states
  - [ ] Empty states
  - [ ] Error states
- **Screenshot** : (a prendre en solo)
- **Notes agent** : "j'ai utilise shadcn par defaut, probablement a harmoniser avec le reste du Hub"
```

---

## Reviewed (archive)

_(rien encore reviewe)_
