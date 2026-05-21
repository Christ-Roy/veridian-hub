# [HUB] UI — suite sprint v1.4 (UX features livrées back)

> **Type** : UI / UX
> **Sévérité** : 🟡 P1 — back livré sans face visible utilisateur
> **Owner** : agent Hub
> **Créé** : 2026-05-21 (post-clôture sprint v1.4)
> **Refs** : memory `project_sprint_v14_complete_2026-05-21`

## Contexte

Sprint v1.4 a livré beaucoup de back (Stripe orchestrator, webhook receivers, invitations 4b, workspace provisioning, etc.) mais **plusieurs features manquent leur UI**. Ce ticket regroupe ce qui doit prendre vie côté dashboard.

---

## 1. Page d'acceptation invitation `/invite/[token]` (P1)

**État actuel** : route API livrée (`/api/invitations/[token]/accept`) + client downstream câblé. Mais la page UI `app/invite/[token]/page.tsx` doit gérer les 3 cas de réponse :

1. **downstream_call=completed** → redirect immédiat vers `redirect_url` (login_url retourné par l'app downstream).
2. **downstream_call=pending** → afficher "Votre accès est en cours d'attribution, ouvrez Notifuse/Prospection dans quelques secondes" + bouton "Réessayer" qui retry l'accept.
3. **downstream_call=error** → message clair selon `error` code (workspace_suspended, role_conflict, etc.).

Si user non-loggué → afficher :
- Boutons OAuth Google/Microsoft (réutiliser composant SignInProviders du dashboard)
- Bouton "Créer un compte par email" (renvoie sur signup avec returnTo=/invite/[token])

**Tests E2E** : `e2e/staging-full/05-invitation-flow.spec.ts` (existe peut-être déjà partiellement, à compléter).

---

## 2. Sidebar — afficher le nom du workspace courant (P1)

**État actuel** : commit `29737a4` du sprint a ajouté de la logique workspace provisioning + le composant `components/app-sidebar.tsx` a été touché. Vérifier que le nom du workspace est bien affiché en haut du sidebar à côté du nom user.

À tester :
- User avec workspace "Personnel — Robert" → "Robert" affiché en haut sidebar
- Switching de workspace (si on prévoit multi-workspace P3) → dropdown

---

## 3. Page `/dashboard/workspace/members` post-backfill (P1)

**État actuel** : commit `f88b8c0` avait posé un placeholder UI sur `/members` car 23/23 users orphelins. Maintenant que le backfill est fait (23 workspaces créés), le placeholder doit être **retiré** et remplacé par la vraie page liste membres :

- Liste des membres du workspace courant (email + role + joinedAt)
- Bouton "Inviter un membre" → modale qui POST `/api/workspace/invite/create`
- Si role=OWNER : possibilité de retirer un membre (POST /api/workspace/members/remove)
- Pagination si > 25 membres

**Vérif** : la page `app/dashboard/workspace/members/page.tsx` a été touchée par le sprint (commit 29737a4) — probablement déjà partiellement faite, à finir.

---

## 4. Email MJML "Invitation cross-app" (P1)

**État actuel** : route `/api/invitations/create` envoie probablement un email basique (à vérifier). Doit être remplacé par un template MJML "veridian-invitation" :

- Header : logo Veridian + nom de l'inviteur
- Body : "Vous avez été invité par X à rejoindre le workspace Y sur Notifuse/Prospection"
- CTA : "Accepter l'invitation" → URL `/invite/[token]` côté Hub
- Footer : mentions légales, lien désinscription

Utiliser le skill `notifuse-templates`. Envoyer via `notifuseClient.sendEmail`.

**Tests** : couverture vitest pour le sendEmail + E2E qui clique sur le lien email mock.

---

## 5. Bandeau trial actif (à venir post-trial-state-machine) (P2)

**Bloqué par ticket #3** sprint v1.4 (`2026-05-21-trial-state-machine.md`). Une fois la state machine livrée, l'UI Hub doit afficher dans le sidebar/header :

- "Trial Pro 12j restants" si état=`trial_active`
- "Trial expire dans 3j — Ajoute ta carte" si `trial_ending_soon` (avec CTA paywall)
- "Trial expiré" → bouton réactiver subscription

Pas urgent maintenant (trial pas implémenté), mais à inclure dans le sprint trial.

---

## 6. Boutons OAuth manquants sur landing/login fallback (P2)

Tickets existants :
- `2026-05-20-fallback-login-apps-redirect-hub.md` — login fallback apps redirige vers Hub OAuth
- `2026-05-20-google-one-tap-landing-pages.md` — Google One Tap popup landing

À grouper avec ce ticket UI pour cohérence visuelle.

---

## 7. UI billing — afficher plans + downgrade/upgrade (P2)

**État actuel** : `lib/pricing/plans.ts` a 18 `🚧 TODO_PRICE / TODO_STRIPE` placeholders (cf ticket dette technique #2). Une fois les prices Stripe créés, l'UI billing doit :

- Lister les plans disponibles (Pro, Business, Enterprise) avec prix mensuel/annuel
- Bouton "Upgrade" → checkout Stripe session
- État subscription actuel (plan, next billing date, status)
- Bouton "Annuler la subscription" → portail Stripe billing

Source de vérité : `docs/PRICING-VERIDIAN.md` (philosophie générosité maximale figée par Robert 2026-05-21).

**Bloqué** par ticket dette tech #2.

---

## 8. Sidebar — pricing trial badge (P2)

Si user en free trial → afficher un badge "Essai gratuit — Xj restants" en haut sidebar (comme Prospection fait : `Essai gratuit — 7j` vu dans le code Prospection).

Cohérence cross-app avec Notifuse + Prospection.

---

## DoD

- [ ] Page `/invite/[token]` couvre les 3 cas downstream (completed/pending/error) + boutons OAuth si non-loggué
- [ ] Sidebar affiche nom workspace courant
- [ ] `/dashboard/workspace/members` liste membres + invite + remove
- [ ] Template MJML invitation cross-app livré
- [ ] Audit UX manuel sur les 5 features sprint v1.4 — chaque feature a SON face visible utilisateur

## Suite

- Ticket dédié pour bandeau trial une fois trial-state-machine livré
- Coordination avec ticket UI Prospection (cohérence sidebar/header design)
