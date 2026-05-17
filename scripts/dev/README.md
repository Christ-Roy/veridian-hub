# Scripts Dev — Hub Veridian

> **NE JAMAIS** lancer ces scripts en production. Tous sont marqués `NODE_ENV=development`.
> **NE JAMAIS** committer avec des credentials hardcodés.

## 📋 Scripts disponibles

### `seed-dev-user.mjs`

Crée un user dev (Credentials provider) dans `hub_app.users` + déclenche le
provisioning Notifuse + Prospection via l'API Hub locale.

```bash
node scripts/dev/seed-dev-user.mjs
```

### `migrate-stripe-products.mjs`

Sync les Stripe Products → table `hub_app.products` côté Prisma.

```bash
node scripts/dev/migrate-stripe-products.mjs
```

## 📝 Variables d'environnement requises

Les scripts utilisent `.env.local` :

```bash
DATABASE_URL=postgresql://veridian:password@localhost:5432/veridian?schema=hub_app
NOTIFUSE_API_URL=https://notifuse.staging.veridian.site
NOTIFUSE_HUB_API_SECRET=staging-secret
PROSPECTION_API_URL=https://prospection.staging.veridian.site
PROSPECTION_TENANT_API_SECRET=staging-secret
NODE_ENV=development
```

## 🔄 Workflow

1. **Local dev** : `pnpm dev` (Next.js sur :3000)
2. **Seed user** : `node scripts/dev/seed-dev-user.mjs`
3. **Tester via dashboard** : http://localhost:3000/signup ou /signin avec le user seeded
4. **Cleanup** :
   ```sql
   DELETE FROM hub_app.tenants WHERE user_id IN (
     SELECT supabase_user_id::uuid FROM hub_app.users WHERE email LIKE 'test%'
   );
   DELETE FROM hub_app.users WHERE email LIKE 'test%';
   ```

## 📖 Documentation

- Notifuse API : voir `lib/notifuse/client.ts` côté Hub
- Prospection API : voir `utils/tenants/provision.ts` côté Hub
- Contrat d'intégration Hub : voir `todo/integrations/README.md`
