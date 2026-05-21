# [HUB] Sync v1.4 contrat — alignement docs + actions Hub

> **Type** : Mise à jour contractuelle + alignement Hub
> **Sévérité** : 🟡 P2 (doc) + 🔴 P1 sur quelques actions Hub (cf §3 du ticket)
> **Owner** : agent Hub
> **Créé** : 2026-05-21 par l'agent Prospection (suite brainstorm Robert)
> **Réfère** : `docs/CONTRAT-HUB.md` v1.4 + `docs/CONTRAT-HUB-API-REF.md` v1.0

## Contexte

Suite au brainstorm Robert 2026-05-21 sur la sync workspace cross-app
("comment ça marche pour les freemium, les invités, les users qui existent
déjà avant Hub"), bump du contrat de v1.3 → v1.4 avec :

- **§1.4 Hub source de vérité + résilience apps** : règle fondamentale.
  Apps doivent survivre Hub-down. Anti-pattern interdit : call Hub
  synchrone dans hot path user.
- **§3.7 Modèle d'identité user cross-app** : email canonique + colonne
  nullable `hub_user_id` côté apps. Pas de migration destructive.
- **§4.4 Cycle de vie d'un membre** : 2 manières exclusives (owner OU
  invité), signup Hub ne crée AUCUN tenant ni membership.
- **§4.5 Articulation freemium personnel ↔ membre chez autrui** : un user
  peut combiner 0..1 tenant owner + 0..N memberships invité.
- **§5.22 Invitation cross-app workspace-level (P1)** : grave l'endpoint
  `attach-member` workspace-level que les apps doivent exposer. Articule
  avec §5.18 sync-member tenant-level (les 2 coexistent).
- Nouveau doc compagnon **CONTRAT-HUB-API-REF.md** : référence technique
  exhaustive endpoint par endpoint avec schemas, codes erreur, curl,
  tests.

## 1. État Hub au 2026-05-21 (audit agent Prospection)

✅ Livré récemment (5/9 étapes P1 invitation) :
- Migration `cross_app_invitations` (commit `d2d5b01`)
- `POST /api/invitations/create` (HMAC m2m, `857bdb3`)
- `GET /api/invitations/[token]/verify` (public, `186b59a`)
- `POST /api/invitations/[token]/accept` étape 4a (`e8adb50`, retourne 202)
- `POST /api/invitations/revoke/[id]` (`dce6f78`)

🟡 Bloqué attente apps :
- Étape 4b : câbler le call `attach-member` côté Notifuse + Prospection.
  → Tickets posés `2026-05-21-hub-attach-member-endpoint.md` dans les 2 repos.
  → Une fois livré : `lib/invitations/accept.ts:112` câble le call HMAC,
    bascule 202 → 200, renvoie `login_url`.

⏳ Étapes 5-9 :
- 5. UI `/invite/[token]/page.tsx` : compléter (redirect post-accept, boutons OAuth si non loggué)
- 7. Email MJML "Invitation" via Notifuse + envoi auto
- 8. E2E Playwright invite→email→click→accept→redirect
- 9. Doc dans CONTRAT-HUB §3.6 — fait dans le bump v1.4 (§5.22)

## 2. Actions Hub immédiates pour v1.4 (P1)

### 2.1 Provisionner les secrets cross-app

Selon `CONTRAT-HUB-API-REF.md` §INV-CREATE, l'endpoint `attach-member` côté
apps est appelé en HMAC avec le secret partagé. Aujourd'hui ces secrets
existent partiellement :

| Secret | État Hub | Action |
|---|---|---|
| `PROSPECTION_HUB_API_SECRET` | ✅ existe | OK |
| `NOTIFUSE_HUB_API_SECRET` | ✅ existe | OK |
| `PROSPECTION_HUB_API_SECRET_STAGING` | 🟡 vérifier | Tracker `veridian-infra/todo/TODO-LIVE.md` |
| `NOTIFUSE_HUB_API_SECRET_STAGING` | ❌ manquant GH Secrets | À ajouter (cf v1.1 §6.5 dette restante) |
| `PROSPECTION_WEBHOOK_TOKEN` | ❌ pas encore créé | À provisionner pour activer webhooks Prospection→Hub |

### 2.2 Câbler le call attach-member côté accept

Une fois Prospection + Notifuse auront livré leur endpoint `attach-member`,
côté `lib/invitations/accept.ts:112` TODO P1-step4b :

```typescript
// Pseudo-code
const downstreamResponse = await callDownstreamHmac({
  app: invitation.target_app,
  path: `/api/veridian/workspaces/${invitation.target_workspace_id}/attach-member`,
  body: {
    hub_user_id: session.user.id,
    hub_user_email: session.user.email,
    role: invitation.target_role,
    invitation_id: invitation.id,
  },
});

if (downstreamResponse.ok) {
  return Response.json({
    accepted: true,
    invitation_id: invitation.id,
    target_app: invitation.target_app,
    target_workspace_id: invitation.target_workspace_id,
    downstream_call: 'completed',
    downstream_member_id: downstreamResponse.member_id,
    redirect_url: downstreamResponse.login_url,
  }, { status: 200 });
}

// Fallback Hub-down côté app : reste en 202 + downstream_call: 'pending'
```

### 2.3 Bumper le doc UI

- Ajouter dans `/invite/[token]/page.tsx` la gestion des 2 états downstream :
  - `completed` → redirect direct vers `login_url`
  - `pending` → afficher "Votre accès est en cours d'attribution, ouvrez Notifuse/Prospection dans quelques secondes" + bouton manuel
- Boutons OAuth Google/Microsoft si user non loggué (réutilise le composant existant signup/signin)

## 3. Actions de fond v1.4 (P2)

### 3.1 Discovery endpoint cross-app (§5.12)

Le contrat v1.4 grave que les apps doivent exposer `GET /api/users/by-email?email=X`
(HMAC). Côté Hub, on a besoin d'un service `lib/hub/discoverUserApps.ts`
qui interroge les 4 apps en parallèle au login et agrège.

Ticket existant `2026-05-20-hub-discovery-by-email-pattern.md` — re-prioriser
maintenant que le contrat est figé sur le pattern.

### 3.2 Webhook receiver côté Hub

Aujourd'hui Hub n'a pas de route `POST /api/webhooks/<app>` pour recevoir
les événements app→Hub (tenant.touched, member_role_changed, etc.).

Spec dans `CONTRAT-HUB-API-REF.md` section "Webhooks app → Hub". À implémenter :
- `POST /api/webhooks/notifuse`
- `POST /api/webhooks/prospection`
- Dédup sur `idempotency_key` (table `hub_webhook_dedup`, fenêtre 24h)
- Bearer token vérif (`PROSPECTION_WEBHOOK_TOKEN`, `NOTIFUSE_WEBHOOK_TOKEN`)

### 3.3 Migration tenant_members (§5.18 backfill)

Aujourd'hui `hub_app.tenant_members` est probablement vide (ou n'existe
même pas). Quand les apps livreront §5.18 sync-member + leurs webhooks
de migration douce, Hub doit pouvoir recevoir les `tenant.member_migrated_to_v13`
et insérer les rows.

À vérifier : la table `hub_app.tenant_members` existe-t-elle ? Sinon créer
migration Prisma avec :
```prisma
model TenantMember {
  tenantId          String   @map("tenant_id")
  userId            String   @map("user_id")
  role              String   @default("member")
  joinedAt          DateTime @default(now()) @map("joined_at")
  deletedAt         DateTime? @map("deleted_at")
  lastKnownAppRole  String?  @map("last_known_app_role")
  @@id([tenantId, userId])
  @@map("tenant_members")
  @@schema("hub_app")
}
```

## 4. Référence

- `docs/CONTRAT-HUB.md` v1.4 (bumpé 2026-05-21, +514L par rapport à v1.3)
- `docs/CONTRAT-HUB-API-REF.md` v1.0 (nouveau, 1277L)
- Mémo agent Prospection : audit cross-app exhaustif 2026-05-21 (3 rapports)

## Réponse attendue

Sous `## Réponse — YYYY-MM-DD` en fin de ce fichier, puis `done/` une fois
toutes les actions §2 et §3 traitées.
