# Scripts Dev — Hub Veridian

> **NE JAMAIS** lancer ces scripts en production. Tous sont marqués `NODE_ENV=development`.
> **NE JAMAIS** committer avec des credentials hardcodés.

## 🚀 Démarrer de zéro

```bash
./scripts/dev/db-up.sh                      # Postgres local + migrations Prisma
# copie la ligne DATABASE_URL affichée dans ton .env.local (ignoré par git)
pnpm dev                                    # Next.js sur :3000
node scripts/dev/seed-dev-user.mjs          # un compte pour se connecter
```

### 🔴 Le port 5433 est un piège sur les machines du cluster

Sur le bastion Contabo (et toute machine faisant tourner un client Nomad), le
port **5433 est déjà le port statique du Patroni `hub-staging-db`**. La règle
DNAT posée par CNI passe **avant** celle de Docker :

```
CNI-HOSTPORT-DNAT --dport 5433 -> 172.26.64.217:5433   (Patroni staging)
DOCKER            --dport 5433 -> 172.17.0.x:5432      (ton conteneur)
```

Un conteneur local publié sur 5433 démarre donc sans broncher, mais toutes les
connexions vers `localhost:5433` partent sur **la base staging**, qui possède
elle aussi un rôle `hub`. D'où le message trompeur :

```
password authentication failed for user "hub"
```

Ce n'est pas un mot de passe périmé, c'est une collision de port. Et le cas
dangereux n'est pas l'erreur : c'est celui où ça « marche ». Avec le mot de
passe staging (présent dans `~/credentials`), on croit développer en local
alors qu'on écrit dans la base staging.

`db-up.sh` utilise donc **5439** et refuse de continuer s'il détecte que le
port est détourné. Pour vérifier par toi-même :

```bash
sudo iptables -t nat -S | grep 5439
HUB_DEV_DB_PORT=5441 ./scripts/dev/db-up.sh --reset   # si besoin d'un autre port
```

## 📋 Scripts disponibles

### `db-up.sh`

Postgres 16 local jetable (`hub-dev-pg`) + `prisma migrate deploy`. Mêmes
user/base/schema qu'en staging et en prod (`hub` / `hub` / `hub_app`) pour que
rien ne diverge. Idempotent.

```bash
./scripts/dev/db-up.sh           # démarre + migre
./scripts/dev/db-up.sh --reset   # DÉTRUIT les données et repart de zéro
```

La base est vide, locale, sans TLS, écoute uniquement sur 127.0.0.1, et son mot
de passe est trivial et public : il ne protège rien. N'y mets aucune donnée
réelle et ne réutilise pas ce mot de passe ailleurs.

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

Les scripts utilisent `.env.local`, qui est **ignoré par git** — les vraies
valeurs vivent dans `~/credentials/.all-creds.env`, jamais dans le repo.

```bash
# Fournie par ./scripts/dev/db-up.sh — ne l'invente pas, ne remets pas 5433.
DATABASE_URL=postgresql://hub:hub-local-dev@localhost:5439/hub?schema=hub_app

# Provisioning cross-app. Ces deux services pointent le VRAI staging : un seed
# local y crée de vrais tenants. À laisser vides tant que tu ne testes pas le
# provisioning.
NOTIFUSE_API_URL=https://notifuse.staging.veridian.site
NOTIFUSE_HUB_API_SECRET=<voir ~/credentials/.all-creds.env>
PROSPECTION_API_URL=https://prospection.staging.veridian.site
PROSPECTION_TENANT_API_SECRET=<voir ~/credentials/.all-creds.env>

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
