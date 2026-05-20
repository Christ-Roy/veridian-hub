# [CROSS-APP] Refactor flow invitation Prospection pour passer par le Hub

> **Type** : Ticket cross-app, owner = agent Prospection (Hub fournit la spec)
> **Sévérité** : 🔴 P1 — bloque la cohérence identité Veridian
> **Owner principal** : agent Prospection (`veridian-prospection`)
> **Owner secondaire** : agent Hub (référence implémentation)
> **Créé** : 2026-05-20

## Contexte

Depuis l'arrivée d'OAuth Sign-in Hub (Google + Microsoft) le 2026-05-20, on a
formalisé que **l'identité utilisateur Veridian est centralisée côté Hub**
(`hub_app.users`). Chaque app downstream (Notifuse, Prospection, Analytics)
provisionne ses propres rows users via le contrat HMAC §3 du `CONTRAT-HUB.md`,
qui exige que le user owner soit créé/attaché par appel API depuis le Hub.

**Mais le flow d'invitation Prospection actuel court-circuite le Hub** :
quand un utilisateur Prospection invite un collègue à rejoindre son
workspace, Prospection crée directement un user dans `prospection_db.users`
+ envoie un magic link Prospection (URL `prospection.app.veridian.site/...`).
L'invité clique, atterrit sur Prospection, devient membre du workspace.

**Conséquence** : l'invité existe côté Prospection mais **PAS** côté
`hub_app.users`. S'il tente ensuite "Continuer avec Google" sur
`app.veridian.site/login` (parce qu'il veut accéder au Hub), Auth.js v5 crée
un user Hub neuf — orphelin de son workspace Prospection.

## Impact business

1. **Identité dupliquée** : le user a 2 entrées Veridian (Hub user + Prospection
   user), sans lien logique.
2. **Billing impossible** : si l'user veut payer un plan Prospection, le
   Stripe Customer côté Hub ne sait pas qu'il a déjà un usage Prospection.
3. **Mauvaise UX** : connecté au Hub, l'user voit "Aucune app activée" alors
   qu'il est déjà membre actif d'un workspace Prospection.
4. **Email confusion** : Notifuse envoie au mauvais user_id si la cible
   est l'invité (pas l'owner).
5. **RGPD** : suppression du compte côté Hub ne nettoie pas Prospection.

## Spec attendue côté Prospection

### Modifier le flow `POST /api/workspaces/:id/invite`

**Aujourd'hui (à supprimer)** :
```
Owner du workspace clique "Inviter Alice" → Prospection crée user Alice
→ envoie magic link prospection.app.veridian.site/signin?token=...
→ Alice clique → atterrit sur Prospection → membre
```

**Demain (à câbler)** :
```
Owner du workspace clique "Inviter Alice" → Prospection appelle
POST https://app.veridian.site/api/invitations/create (HMAC Hub-side)
  body: {
    inviter_user_id: "<hub_user_id de l'owner>",
    inviter_email: "owner@example.com",
    invitee_email: "alice@example.com",
    target_app: "prospection",
    target_workspace_id: "<prospection_workspace_id>",
    target_role: "member",
    message: "Owner t'invite à rejoindre son workspace prospection"
  }
→ Hub crée hub_app.invitations row, envoie magic link
  app.veridian.site/invite/<token>
→ Alice clique → atterrit sur Hub /invite/<token>
→ 2 chemins :
  (a) Alice n'a pas de compte Hub : signup wizard (Google/Microsoft/email)
      → après signup, Hub appelle POST prospection/api/tenants/attach-owner
        avec son user_id Hub + workspace_id Prospection
      → Alice atterrit sur dashboard Hub avec workspace Prospection lié
  (b) Alice a déjà un compte Hub : login (Google/Microsoft/email)
      → idem (a), Hub appelle attach-owner et redirige Alice vers
        prospection.app.veridian.site (auto-login magic link)
```

### Endpoint à ajouter côté Hub (à créer en parallèle)

`POST /api/invitations/create` (auth HMAC, appelé par Prospection)
- body : `{ inviter_user_id, inviter_email, invitee_email, target_app, target_workspace_id, target_role, message }`
- response : `{ invitation_id, magic_link_url, expires_at }`

`GET /api/invitations/[token]` (page publique)
- vérifie le token, affiche page d'acceptation
- Login si pas de compte, sinon link direct

`POST /api/invitations/accept` (auth user)
- valide token + workspace
- appelle l'app downstream pour attacher l'user au workspace
- redirige vers l'app downstream avec magic link

### Migrations DB

- **Hub** : nouvelle table `hub_app.invitations` (id, token, inviter_user_id, invitee_email, target_app, target_workspace_id, target_role, expires_at, accepted_at, message)
- **Prospection** : table d'invitations actuelle (si existe) à conserver
  ou à supprimer selon besoin local — minimum garder le mapping
  invitation_hub_id ↔ prospection_workspace_id

## Cas d'usage à supporter

- [ ] Owner invite par email un user qui n'existe nulle part (Hub ni Prospection)
- [ ] Owner invite un user qui existe côté Hub mais pas Prospection
- [ ] Owner invite un user qui existe côté Hub avec autre Prospection workspace
- [ ] Re-invitation (token expiré) : génère un nouveau token, n'écrase pas l'ancien si en attente
- [ ] Revocation invitation par owner avant acceptation
- [ ] Invitation acceptée par un user loggué Google différent de l'email invité

## Impact effort estimé

| App | Effort | Détails |
|---|---|---|
| Hub | 5-7j | Nouvelle table + 3 endpoints + page `/invite/[token]` + tests |
| Prospection | 3-4j | Modifier flow `POST /workspaces/:id/invite` pour appeler Hub, retirer la table invitations locale |
| Tests intégration | 2-3j | Scenario end-to-end "owner invite → invitee signup → workspace member" |
| Migration data existante | 1j | Si des invitations en cours côté Prospection, les migrer vers Hub.invitations |

## Bloque

- ⚠️ **Tout onboarding multi-membre payant Prospection** tant que non livré
- ⚠️ **Tickets Notifuse/Analytics du même type** : si Notifuse veut un flow
  invite multi-membre, il faudra le même refactor → faire la spec Hub une
  seule fois et la réutiliser

## Référence

- `CONTRAT-HUB.md` §3 (Patterns auth Hub ↔ app)
- `CONTRAT-HUB.md` §6bis (Autologin SSO-stack Veridian 3 couches)
- `veridian-hub/todo/2026-05-20-oauth-scenarios-coverage.md` scénarios G/H
- Auth.js v5 OAuth concepts (auto-link email verified) : https://authjs.dev/concepts/oauth

## Réponse Prospection — (à compléter par l'agent Prospection)

À ajouter ici quand l'agent Prospection prend ce ticket :
- Date de prise en charge
- Branche feature côté Prospection
- ETA livrable
- Questions/clarifications
