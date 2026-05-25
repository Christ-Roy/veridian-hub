# [HUB] MEGA E2E — mock-oauth ne déclenche pas provisionDefaultWorkspace

> **Sévérité** : 🟡 P1 — bloque 3 specs MEGA (A-01, A-02, J-01)
> **Owner** : agent Hub
> **Créé** : 2026-05-25 par team-lead mega-e2e
> **Refs** : MEGA E2E run 3 sur SHA c85fda4 → 169 passed / 5 failed

## Contexte

Sur la mega battery, les specs `A-01 signup OAuth Google`, `A-02 signup OAuth Microsoft`, `J-01 GDPR setup` échouent toutes avec :

```
Error: workspace par défaut doit avoir été provisionné (provisionDefaultWorkspace)
Expected: >= 1
Received: 0
```

Le helper `megaSignIn` utilise le mock-oauth provider (activé `OAUTH_TEST_PROVIDER=true` en staging) qui s'enregistre comme un provider OAuth Auth.js v5. Le user est bien créé en DB Hub (`hub_app.users` contient une row), mais **aucun workspace par défaut** n'est créé.

## Investigation faite

- Les logs hub-staging montrent `[workspace-provision] created default workspace for user` pour les emails `e2e-mega-a-03-credentials-*` (A-03 utilise le flow Credentials, marche)
- Mais AUCUN log similaire pour `e2e-mega-a-01-google-*` ni `e2e-mega-a-02-microsoft-*` (mock-oauth)
- L'event Auth.js `createUser` est censé déclencher `createCreateUserEvent` (auth.ts) qui appelle `provisionDefaultWorkspace`
- Hypothèses :
  1. L'event `createUser` n'est PAS fired par le PrismaAdapter sur mock-oauth (peut-être que la session existe déjà et l'adapter skip la création)
  2. `provisionDefaultWorkspace` throw silencieusement (try/catch dans createUser event) sans log
  3. Le mock-oauth provider utilise un `userId` qui n'est pas reconnu par le helper

## Action attendue

1. Reproduire en local : signup via mock-oauth + check si event createUser fire
2. Si non-fired : modifier le mock-oauth provider pour explicitement déclencher provisionWorkspace
3. Si fired mais skip : check la logique `result.created` dans provisionDefaultWorkspace
4. Ajouter un test unitaire mock-oauth + workspace provision
5. Re-run mega battery → confirmer A-01, A-02, J-01 verts

## Specs impactées
- `e2e/staging-full/mega/A-onboarding/A-01-signup-oauth-google.spec.ts:83`
- `e2e/staging-full/mega/A-onboarding/A-02-signup-oauth-microsoft.spec.ts:68`
- `e2e/staging-full/mega/J-gdpr/J-01-delete-tenant-cascade.spec.ts:128`
