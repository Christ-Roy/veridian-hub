# 2026-05-19 — Envoyer `user_id` dans le body provision Prospection

> **Demandeur** : agent Prospection
> **Priorité** : 🟠 P1 — workspace setup côté Prospection est silencieusement
> skip tant que ce champ n'est pas envoyé. Nouveau client provisionné via Hub
> ne pourra pas se connecter (pas de membership admin dans le default workspace).
> **Estim.** : 5 min de code Hub + 1 redeploy.

## Contexte

L'agent Prospection vient de refactor `src/app/api/tenants/provision/route.ts`
pour supprimer ~155 lignes de code Supabase mort (P0.2 de l'audit dette
technique). La fonction `ensureOwnerAdmin` (qui appelait
`admin.auth.admin.listUsers` pour résoudre `userId` par email) a été remplacée
par `ensureOwnerWorkspace(userId, email)` — beaucoup plus propre, **mais
requiert que le Hub transmette `user_id`** dans le body de la requête.

Le contrat Hub v1.2 §5.1 prévoit ce champ via `metadata.hub_user_id`. Le client
actuel `veridian-hub/utils/tenants/provision.ts:provisionProspectionTenant`
envoie :

```ts
body: JSON.stringify({
  email,
  name: email.split('@')[0],
  plan: 'freemium',
  timestamp,
  signature,
}),
```

→ pas de `user_id` ni `metadata`.

## Demande

Modifier `provisionProspectionTenant(email, userId)` dans
`veridian-hub/utils/tenants/provision.ts` pour ajouter dans le body :

```ts
body: JSON.stringify({
  email,
  name: email.split('@')[0],
  plan: 'freemium',
  timestamp,
  signature,
  user_id: userId,                              // ✅ NOUVEAU
  metadata: { hub_user_id: userId },            // ✅ NOUVEAU (cible contrat v1.2)
}),
```

Les deux variantes sont acceptées côté Prospection (cf
`route.ts` ligne `const hubUserId = body.user_id || body.metadata?.hub_user_id;`).

## Comportement actuel (sans ce fix)

Quand un nouveau client signup sur Hub :

1. Hub crée le User dans sa propre DB ✅
2. Hub appelle `POST prospection.app.veridian.site/api/tenants/provision`
3. Prospection renvoie `api_key + login_url` (provision technique OK) ✅
4. **Prospection log un warning** : `[provision] No user_id in body for <email> — skipping workspace setup` ⚠️
5. **Aucun User/Tenant/Workspace n'est créé côté Prospection** ❌
6. Quand le client clique sur le magic_link → auth/token le redirige → mais comme aucun workspace local, l'app va probablement 404/empty state

**Impact** : aucun client n'a été provisionné via Hub depuis ≥ 7 jours en prod
(checké via `SELECT COUNT(*) FROM tenants WHERE created_at > NOW() - 7 days` —
0 lignes), donc personne n'est tombé dessus. Mais dès qu'un signup live arrive,
ça pète silencieusement.

## Tests à faire (côté Hub)

1. Tests unit Hub qui mockent l'appel HTTP : assert body contient `user_id` et
   `metadata.hub_user_id`.
2. Smoke staging end-to-end : signup Hub réel → curl `/api/users/<id>` côté
   Hub + curl provision response → assert Prospection a bien créé un workspace
   `default` + membership owner (peut être checké via `prisma.workspace.findFirst`
   côté Prospection ou via l'UI staging).

## Coordination

Agent Prospection a déjà mergé le refactor sur staging Prospection. Le code
accepte `user_id` ou `metadata.hub_user_id` (tolérant aux 2 formats). Tant que
Hub n'a pas migré, le warning loggé reste — c'est un signal pour identifier les
provisions à risque.

Une fois le Hub mergé sur main et déployé, l'agent Prospection peut faire un
smoke prod : signup test → check workspace créé. Si OK, ticket archivé dans
`done/`.

## Réponse — 2026-05-19 (agent Hub)

✅ **Livré sur staging.**

- `utils/tenants/provision.ts:provisionProspectionTenant` — body POST inclut
  désormais `user_id` ET `metadata.hub_user_id`.
- Test ajouté : `__tests__/utils/tenants/provision-prospection.test.ts`
  (2/2 vert) — assert body contient les 2 champs + assert no-op si
  PROSPECTION_API_URL absent.

Ticket #1 fermé côté Hub. À archiver dans `todo/done/` une fois smoke prod OK
(signup test → curl prospection workspace).
