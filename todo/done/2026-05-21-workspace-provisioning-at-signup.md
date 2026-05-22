# Provisioning workspace par défaut au signup

**Créé** : 2026-05-21
**Trigger** : page `/dashboard/workspace/members` était inaccessible (silent redirect → /dashboard) pour 100% des users prod (23/23) car aucun n'a de workspace. Placeholder UI ajouté en attendant le vrai fix.

## Constat

Requête DB du 2026-05-21 :
```sql
SELECT count(*) FROM hub_app.users;                -- 23
SELECT count(*) FROM hub_app.workspaces;           -- ? (vraisemblablement 0)
SELECT count(*) FROM hub_app.workspace_members;    -- 0 (confirmé)
```

Personne n'a de workspace en prod. La page membres redirigait silencieusement vers `/dashboard` quand `findFirst` Workspace renvoyait null.

Le seul code qui crée du `workspaceMember` est `app/api/workspace/invite/accept/route.ts` (acceptation invitation). Aucun code ne crée un workspace au signup → le bootstrap n'a jamais lieu.

## Ce qui a été fait dans le commit 342cf87+1

Placeholder UI dans `app/dashboard/workspace/members/page.tsx` qui :
- Affiche un message clair "Pas encore de workspace"
- Bouton "Créer mon workspace" disabled avec annotation `(bientôt)`
- Lien vers `/dashboard` pour ne pas bloquer le user

Pas de logique applicative ajoutée — c'est juste de la lisibilité.

## Ce qui reste à faire (vrai fix)

### Décision business à arbitrer d'abord

Quel est le modèle workspace ? 4 options :

1. **Auto-création silencieuse au signup** : à la fin de `/api/auth/signup` (ou event `createUser`), créer un workspace `{name: "Personnel"}` avec `owner_id=user.id` + une row `workspace_members` avec `role=OWNER`. Mono-workspace par user.

2. **Auto-création + flow onboarding** : workspace créé en DB, mais redirect vers `/onboarding/workspace` pour faire saisir le nom + inviter les premiers membres. Plus engageant.

3. **Création explicite par le user** : bouton "Créer mon workspace" actif, formulaire avec nom + slug + plan. Donne plus de contrôle mais ajoute une étape avant la première utilisation.

4. **Workspace optionnel** : la page membres reste un placeholder pour la majorité ; seuls les comptes "Business" ou "Team" en créent un. Cohérent avec le pricing freemium si tu veux gate la collaboration.

→ **Ma reco par défaut** : Option 1 (auto-création silencieuse) pour le freemium, avec affichage du nom dans le sidebar pour rendre l'objet visible. C'est ce que font Linear, Notion, Slack. Migration des 23 users existants à faire en même temps.

### Code à écrire (Option 1)

1. **Migration data prod** — script `scripts/admin/backfill-workspaces.ts` :
   ```ts
   // Pour chaque user sans workspace_members, créer un workspace + member OWNER
   ```
   - Nom par défaut : `${user.name || user.email.split('@')[0]} workspace`
   - Idempotent (skip si déjà membre)
   - Audit log via `audit_log` table

2. **Event Auth.js** — étendre `lib/auth/create-user-event.ts` ou créer un nouveau hook qui crée le workspace après le `supabaseUserId` patch :
   ```ts
   await prisma.workspace.create({
     data: {
       name: `${user.name || user.email.split('@')[0]} workspace`,
       ownerId: user.id,
       members: { create: { userId: user.id, role: 'OWNER' } },
     },
   });
   ```

3. **Route signup Credentials** — `app/api/auth/signup/route.ts` doit aussi créer le workspace après le `prisma.user.create` (cf. comment hier pour `supabaseUserId`).

4. **Tests** :
   - Unitaire : event créé workspace + member OWNER idempotents
   - E2E staging : signup Google/Microsoft → workspace présent en DB → `/dashboard/workspace/members` charge sans placeholder
   - Ajouter assertion dans `e2e/staging-full/04-oauth-flows.spec.ts` (scénarios A et B)

5. **UI** — remplacer le placeholder du commit actuel par un appel à l'API `/api/workspace/create` quand on cliquera le bouton (option 3) OU retirer le placeholder définitivement (option 1, plus de cas "pas de workspace").

### Risques à anticiper

- **Slug unique** : si on génère un slug depuis le nom (`name.toLowerCase().replace(/\s/g, '-')`), 2 users `Robert` créent un conflit. Ajouter suffixe `-${randomSlug()}` ou cuid.
- **Backfill prod** : 23 rows à créer. Faire un dry-run + transaction. Pas critique car aucun process ne dépend des workspaces aujourd'hui (sauf cette page).
- **Multi-workspace P3** : Option 1 enferme dans un mono-workspace. Si tu prévois multi-workspace plus tard, prévoir dès maintenant un workspace "Personnel" identifié comme tel (champ `is_default` ou tag) pour pouvoir ajouter des workspaces équipe ensuite.

## Définition of Done

- [ ] Décision business prise (option 1/2/3/4)
- [ ] Script backfill exécuté en prod (23 workspaces créés)
- [ ] Event/route signup crée le workspace pour tout nouveau user
- [ ] Tests unitaires + E2E couvrent le scénario
- [ ] Placeholder retiré de `app/dashboard/workspace/members/page.tsx`
- [ ] Sidebar affiche le nom du workspace courant
