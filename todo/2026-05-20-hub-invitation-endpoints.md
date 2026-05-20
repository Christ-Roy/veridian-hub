# [HUB] Implémenter endpoints invitation cross-app

> **Type** : Ticket Hub, prérequis pour invitations Prospection/Notifuse multi-membre
> **Sévérité** : 🔴 P1 — débloque le flow multi-membre payant
> **Owner** : agent Hub
> **Créé** : 2026-05-20
> **Bloque** :
>   - `veridian-prospection/todo/2026-05-20-prospection-invite-flow.md`
>   - `notifuse-veridian/todo/2026-05-20-hub-invitation-flow-multi-membre.md`

## Contexte

L'OAuth Sign-in Hub livré 2026-05-20 centralise l'identité utilisateur côté
`hub_app.users`. Mais les flows d'invitation multi-membre côté apps
downstream (Prospection, Notifuse à venir) court-circuitent encore le Hub,
créant des identités orphelines.

Spec complète déjà rédigée dans
`todo/integrations/2026-05-20-prospection-invite-flow.md`. Ce ticket est le
**pendant Hub** : ce qu'il faut développer côté Hub pour que les apps
puissent migrer vers le flow centralisé.

## À livrer

### 1. Migration DB Prisma — table `hub_app.invitations`

```prisma
model Invitation {
  id                  String   @id @default(cuid())
  token               String   @unique // 32 bytes hex, URL-safe
  inviterUserId       String   @map("inviter_user_id")
  inviterEmail        String   @map("inviter_email")
  inviteeEmail        String   @map("invitee_email")
  targetApp           String   @map("target_app")  // 'notifuse' | 'prospection' | 'analytics' | 'cms'
  targetWorkspaceId   String   @map("target_workspace_id")
  targetRole          String   @default("member") @map("target_role")  // 'owner' | 'admin' | 'member'
  message             String?
  expiresAt           DateTime @map("expires_at")
  acceptedAt          DateTime? @map("accepted_at")
  acceptedByUserId    String?  @map("accepted_by_user_id")
  createdAt           DateTime @default(now()) @map("created_at")

  inviter             User     @relation("InvitationsSent", fields: [inviterUserId], references: [id])
  acceptedBy          User?    @relation("InvitationsAccepted", fields: [acceptedByUserId], references: [id])

  @@index([token])
  @@index([inviteeEmail])
  @@index([targetApp, targetWorkspaceId])
  @@map("invitations")
  @@schema("hub_app")
}
```

### 2. Endpoints HTTP

- **POST `/api/invitations/create`** (auth HMAC, appelé par les apps)
  - Body : `{ inviter_user_id, inviter_email, invitee_email, target_app, target_workspace_id, target_role, message }`
  - Crée la row Invitation, génère token, envoie magic link via Notifuse
  - Response : `{ invitation_id, magic_link_url, expires_at }`

- **GET `/api/invitations/[token]/verify`** (public)
  - Vérifie validité token, renvoie inviter_name, target_app, target_workspace_name
  - Response : `{ valid, expired, already_accepted, invitation_meta }`

- **POST `/api/invitations/[token]/accept`** (auth user Hub requis)
  - Vérifie token, exige session user loggué (n'importe quel provider)
  - Vérifie email user matche `invitee_email` (ou autorise mismatch avec warning)
  - Appelle l'app downstream pour attacher l'user au workspace
  - Marque invitation comme accepted
  - Response : `{ redirect_url }` (auto-login vers l'app downstream)

- **DELETE `/api/invitations/[id]`** (auth user Hub, owner du workspace)
  - Permet à l'inviteur de révoquer une invitation en attente

### 3. Pages publiques

- **`/invite/[token]`** : page d'acceptation
  - Si pas loggué : "Tu es invité à rejoindre [workspace] sur [app]. Connecte-toi pour accepter." + boutons OAuth + lien magic email
  - Si loggué avec bon email : "Tu es invité à rejoindre [workspace] sur [app]. Accepter ?" + bouton Accept
  - Si loggué avec mauvais email : warning + bouton "Continue with this account" (override) ou "Logout and re-login"
  - Si déjà accepté : "Tu fais déjà partie de [workspace]" + redirect vers app
  - Si expiré : "Invitation expirée" + CTA pour redemander invitation

### 4. Email template

- Template MJML "Invitation" via Notifuse (skill `notifuse-templates`)
- Variables Liquid : `{{ inviter_name }}`, `{{ workspace_name }}`, `{{ target_app_name }}`, `{{ accept_url }}`, `{{ expires_at }}`

### 5. Tests obligatoires

- Test mapping route↔test (mode Nuclear) → coverage 1-pour-1 sur chaque route.ts
- E2E Playwright : flow complet `invite → email → click → signup → accept → redirect`
- Tests intégration HMAC : vérifier que sans bonne signature, `create` reject
- Tests anti-replay token : un token déjà accepté ne peut pas être ré-utilisé
- Tests expiration : token > 7j expire automatiquement

## Effort estimé

- 1j : migration Prisma + types + adapter Prisma
- 2-3j : 4 endpoints HTTP + page `/invite/[token]`
- 1-2j : email template + intégration Notifuse send
- 2-3j : tests (unit + intégration + E2E)
- 1j : doc dans CONTRAT-HUB.md §3.6 "Invitations multi-membre"

**Total** : ~7-10j pour livraison clean + tests

## Pré-requis

- ✅ OAuth Sign-in Hub livré (2026-05-20)
- ✅ Contrat HMAC en place (depuis 2026-05-17)
- ✅ Notifuse API send email (depuis 2026-05-08)

## Ordre de livraison conseillé

1. Migration DB + Prisma client
2. Endpoint `POST /api/invitations/create` (sans envoi email d'abord, just DB)
3. Tests création + HMAC
4. Endpoint `GET /api/invitations/[token]/verify`
5. Page `/invite/[token]` (UI accept)
6. Endpoint `POST /api/invitations/[token]/accept`
7. Email template + branchement Notifuse send
8. E2E complet
9. Doc CONTRAT-HUB.md
10. Annonce aux agents Prospection + Notifuse qu'ils peuvent migrer leur flow

## Référence

- Spec cross-app détaillée : `todo/integrations/2026-05-20-prospection-invite-flow.md`
- `CONTRAT-HUB.md` §3 (contrat HMAC)
- `CONTRAT-HUB.md` §6 (multi-membre payant)
- Mode Nuclear test mapping : `docs/CI-ARCHITECTURE.md` §1
