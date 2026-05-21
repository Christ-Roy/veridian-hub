# Runbook — Cleanup seed E2E staging

> **Scope** : `hub-staging-db`, `notifuse-staging-db` (`notifuse_system`),
> `postgres-staging` (db `prospection`).
> **Owner** : agent ops Hub.
> **Production** : ❌ **JAMAIS sur `veridian-core-db` ni `postgres` prod.**

## Quand l'exécuter

Au cas par cas, jamais en automatique :

- Après une session E2E intense (sprints invitation, mock-OAuth, scénarios
  Playwright `e2e/staging-full/*`) qui laisse plusieurs centaines de
  `e2e-*@e2e.veridian.site` dans la DB Hub.
- Si la DB staging dépasse arbitrairement 5000 users e2e accumulés
  (`SELECT count(*) FROM hub_app.users WHERE email LIKE '%@e2e.veridian.site';`).
- Avant un test de charge / benchmark staging (pour partir d'un état propre).

⚠️ **Pas pendant un test E2E en cours** : tu vas supprimer les rows que le
test attend (sessions, accounts, etc.).

## Patterns sécurisés (et UNIQUEMENT ceux-là)

Les scripts ciblent **strictement** :

- Hub : `%@e2e.veridian.site` + legacy `e2e-{fresh,invitee,inviter}-*@veridian.site`
- Notifuse / Prospection : `%e2e%` + `%fresh%` dans l'email

Sont **explicitement protégés** :

- `robert+staging-test-*@veridian.test`
- `staging-test*@veridian.site`
- `trial-smoke-*@veridian.site`
- Tout email humain réel (`brunon5robert@gmail.com`, etc.)

## Garde-fous

1. **Pas de pattern large** (`WHERE 1=1`, `LIKE '%@%'`, etc.) — interdit.
2. **Transactionnel** : tout dans `BEGIN/COMMIT`, rollback auto en cas d'erreur.
3. **Idempotent** : rejouable sans plante, les DELETE deviennent no-op.
4. **Pré/post comptage** affiché dans stdout pour audit.
5. **Healthcheck post-cleanup** obligatoire (200 sur `/api/health`).

## Commandes

### Hub staging — script versionné

```bash
ssh dev-pub 'docker exec -i hub-staging-db psql -U hub -d hub' \
  < scripts/admin/cleanup-staging-seed.sql
```

Le script affiche un récap `BEFORE`/`AFTER` + `seed_users_remaining = 0`.

### Notifuse staging

```bash
ssh dev-pub "docker exec notifuse-staging-db psql -U postgres -d notifuse_system -c \"
BEGIN;
DELETE FROM user_workspaces WHERE user_id IN (
  SELECT id FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%'
);
DELETE FROM user_sessions WHERE user_id IN (
  SELECT id FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%'
);
DELETE FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%';
COMMIT;
\""
```

### Prospection staging

```bash
ssh dev-pub "docker exec postgres-staging psql -U app -d prospection -c \"
BEGIN;
DELETE FROM workspace_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%');
DELETE FROM accounts          WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%');
DELETE FROM sessions          WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%');
DELETE FROM mfa_codes         WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%e2e%' OR email LIKE '%fresh%');
DELETE FROM magic_links       WHERE email LIKE '%e2e%' OR email LIKE '%fresh%';
DELETE FROM invitations       WHERE email LIKE '%e2e%' OR email LIKE '%fresh%';
DELETE FROM users             WHERE email LIKE '%e2e%' OR email LIKE '%fresh%';
COMMIT;
\""
```

### Healthcheck post-cleanup (obligatoire)

```bash
for app in hub notifuse prospection; do
  curl -sS -o /dev/null -w "$app: HTTP %{http_code}\n" \
    "https://$app.staging.veridian.site/api/health"
done
```

Attendu : `HTTP 200` partout.

## Référence cleanup 2026-05-21 (run initial)

Compte avant/après sur run inaugural :

| DB | Users avant | Users après | Seed supprimé |
|---|---:|---:|---:|
| `hub-staging-db.hub_app` | 223 | 4 | 219 |
| `notifuse-staging-db.notifuse_system` | 3635 | 3337 | 298 |
| `postgres-staging.prospection` | 31 | 30 | 1 |

Tenants orphelins Hub : 10 supprimés (user_id pointant vers users
inexistants — résidus E2E).

Healthcheck final : Hub 200 / Notifuse 200 / Prospection 200.
