# [HUB] 🟡 P1 — Le pull Analytics doit s'authentifier en clé M2M, pas en password super-admin (anti-pattern Lot B supprimé)

> **Sévérité** : 🟡 P1 (dette d'auth / surface secret en prod ; pas bloquant fonctionnel)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (audit cohérence CROSS-APP, agent `audit-crossapp`)
> **Complète** (ne remplace pas) : `2026-06-17-cabler-env-engine-admin-pull-analytics-prod.md`
> (P0, audit-identite) — celui-ci débloque le pull AVEC le password ; le présent
> ticket corrige le MÉCANISME d'auth pour ne pas pérenniser l'anti-pattern.

## TL;DR

Le pull Analytics (`lib/prospect/engine-client.ts`) s'authentifie à l'engine via
`POST /api/auth.login` avec **email/password super-admin** (`ENGINE_ADMIN_EMAIL`/
`ENGINE_ADMIN_PASSWORD`). C'est l'**anti-pattern que le Lot B a explicitement
supprimé côté bridge** (`[[project_bridge_m2m_native_lot_b]]`, prouvé staging
2026-06-17 : super_admin password → auth M2M `PLATFORM_ADMIN_API_KEY`). Le
commentaire in-code qui justifie le password (« pas d'API key possible sur un
workspace platform-managed, 403 vérifié 2026-06-10 ») est **périmé** : l'endpoint
M2M `workspaces.provisionApiKey` crée désormais une clé `stam_live_*` pour un
workspace platform-managed sans membres, et `export.userEvents` accepte les clés
workspace. La voie propre existe déjà en prod ; le code Hub ne l'a pas adoptée.

## Preuve (vérifiée des deux bouts, 2026-06-17)

### Côté Hub : auth par password super-admin
- `lib/prospect/engine-client.ts:9-14` (commentaire) : « Auth : pas d'API key
  possible sur un workspace platform-managed (403 vérifié côté bridge 2026-06-10)
  → login super-admin programmatique, token 7 j, re-login automatique sur 401. »
- `lib/prospect/engine-client.ts:81-101` : `login()` → `POST /api/auth.login`
  body `{ email: ENGINE_ADMIN_EMAIL, password: ENGINE_ADMIN_PASSWORD }`, stocke
  le JWT, l'envoie en `Authorization: Bearer <jwt>` sur `export.userEvents`.

### Côté engine : la voie M2M propre existe maintenant (postérieure au commentaire)
- `api/src/admin-platform/admin-platform.service.ts:181-204`
  (`provisionApiKey`) : « Provision a workspace-scoped API key for an EXISTING
  (platform-managed) workspace [qui] has no members, so the normal
  apiKeys.create (WorkspaceAuthGuard + member) [n'est pas applicable] » →
  retourne `{ workspace_id, api_key (stam_live_*), key_prefix }`. Exposé en M2M :
  `api/src/admin-platform/admin-platform.controller.ts:47`
  (`POST /api/admin/platform/workspaces.provisionApiKey`, `PlatformAdminGuard`).
- `api/src/export/export.controller.ts:21-23` : `GET export.userEvents` est gardé
  par `WorkspaceAuthGuard`, qui accepte une clé `stam_live_*` du bon workspace
  (`api/src/common/guards/workspace.guard.ts:55-81`, branche `ApiKeyPayload`).
- Donc : **une clé workspace `stam_live_*` provisionnée en M2M suffit pour pull
  `export.userEvents`** — plus besoin du password super-admin. Le « 403 du
  2026-06-10 » n'est plus vrai depuis le Lot B.

## Demande précise (quoi changer, où)

1. **Provisionner une clé workspace M2M pour le pull** (une fois, via le Hub ou
   le skill, contre l'engine prod) :
   ```bash
   curl -X POST https://analytics-engine.app.veridian.site/api/admin/platform/workspaces.provisionApiKey \
     -H "Authorization: Bearer $PLATFORM_ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{ "workspace_id": "vrd_veridian_site_prod", "name": "hub-pull-analytics", "role": "viewer" }'
   # → { workspace_id, api_key: "stam_live_...", key_prefix }
   ```
   (rôle minimal suffisant pour `export.userEvents` — `viewer`/`analyst`, à
   confirmer via `hasPermission` dans `workspace.guard.ts`).
2. **Remplacer l'auth dans `lib/prospect/engine-client.ts`** : retirer `login()`
   + le re-login 401, envoyer directement `Authorization: Bearer <ENGINE_API_KEY>`
   (clé `stam_live_*`). Supprimer `ENGINE_ADMIN_EMAIL`/`ENGINE_ADMIN_PASSWORD`,
   introduire `ENGINE_API_KEY`. Mettre à jour `isConfigured()` (`apiKey.length > 0`)
   et `engineConfigFromEnv`.
3. **Câbler l'ENV dans le déploiement (même commit)** — `[[feedback_env_wire_compose_same_commit]]` :
   `ENGINE_API_KEY` dans le compose Hub prod (`${ENGINE_API_KEY:?}`) + workflow CI
   (secret → env → heredoc `.env`) + `.env.example`. Remplace les 2 ENV password
   du ticket P0 (coordonner : si le P0 a déjà posé `ENGINE_ADMIN_*`, les retirer
   ici).
4. **Mettre à jour le commentaire périmé** `engine-client.ts:9-14` (le « 403 »
   n'est plus vrai depuis le Lot B).
5. **Corriger le ticket P0** `2026-06-17-cabler-env-engine-admin-pull-analytics-prod.md`
   §Demande #1 : il affirme « c'est bien un login email/password super-admin
   qu'il faut » — à amender vers la clé M2M (ou livrer directement ce ticket à la
   place, vu que les deux touchent la même config).

## Ce qui NE change PAS
- Le design PULL lui-même (acté par audit-identite, code 2026-06-17). Ce ticket
  ne ré-ouvre PAS le débat pull/push — il corrige uniquement le MÉCANISME d'auth
  du pull.
- La sémantique d'ingestion (`page.hit` + jalons `audit.*` via `ingestProspectEvent`).

## Impact si non fait
- Un secret password super-admin engine vit en prod côté Hub (`ENGINE_ADMIN_PASSWORD`),
  porteur de privilèges larges (login super-admin = bien plus qu'un read-only
  export). Une clé workspace `viewer` réduit la surface au strict nécessaire
  (principe du moindre privilège).
- Incohérence inter-app : le bridge est passé M2M (Lot B), le Hub reste sur le
  password supprimé → deux mécanismes d'auth pour le même engine, dette qui
  rouvre à chaque audit.

## Dépendances
- `[[project_bridge_m2m_native_lot_b]]` (la voie M2M dont ce ticket réclame
  l'adoption côté Hub).
- Couplé au P0 ENV (`2026-06-17-cabler-env-engine-admin-pull-analytics-prod.md`)
  — même fichier compose, à livrer ensemble pour éviter un double aller-retour
  Dokploy. Reco : fusionner les deux en un seul PR (câbler directement en M2M
  plutôt que poser le password puis le retirer).
