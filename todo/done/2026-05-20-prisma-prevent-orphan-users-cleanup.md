# [HUB] Job de nettoyage des users Hub orphelins (sans accounts ni sessions)

> **Type** : Hygiène DB
> **Sévérité** : 🟢 P3 (pas critique, mais évite l'accumulation)
> **Owner** : agent Hub
> **Créé** : 2026-05-20
> **✅ LIVRÉ (DRY-RUN)** : 2026-05-20 (commit `cca2cec`, smoke prod OK)
>
> **Réalisé** :
> - `lib/admin/find-orphan-users.ts` : fonction pure, exclut les users
>   avec un Tenant via la corrélation `supabaseUserId` (UUID bridge).
>   Protection critique anti-suppression-de-tenant.
> - `POST /api/cron/cleanup-orphan-users` (CRON_SECRET, dry-run strict)
> - `GET  /api/admin/users/orphans` (requireAdmin, consultation)
> - 18 tests vitest (400/400 vert)
> - Smoke prod 2026-05-20 : 2 orphelins réels détectés
>   * `lemaireq.84@gmail.com` (42 jours)
>   * `jimmybrumant@gmail.com` (40 jours)
>
> **⚠️ Auto-delete pas livré (volontaire)** :
> - Politique de rétention RGPD pas encore figée (cf. page /legal)
> - Delete sera fait manuellement par Robert via Prisma Studio ou SQL
> - Si on veut passer en auto-delete plus tard : nouveau ticket avec
>   politique RGPD claire + double cooling-off (genre dry-run 30j puis
>   delete 30j plus tard)

## Contexte

Avec OAuth Sign-in + plusieurs providers, il est possible qu'un user Hub
soit créé puis abandonné (signup commencé, jamais finalisé, OAuth refusé en
cours de route, etc.) → row `hub_app.users` sans `accounts` ni `sessions`
correspondantes.

Aujourd'hui aucun cron de nettoyage. À long terme, accumulation de "users
fantômes" qui peuvent corrompre les stats produit ("X signups ce mois" gonflé).

## À livrer

- [ ] Cron Hub `cron-cleanup-orphan-users.ts` (Vercel Cron ou GitHub Actions
      scheduled) qui :
      - Detect `hub_app.users` avec `createdAt < NOW() - 7 days` ET aucun
        row `accounts` ni `sessions` ni `mfaCodes`
      - Log la liste détectée (pas auto-delete d'emblée)
      - Optionnel : delete après 30j si toujours orphelin
- [ ] Endpoint admin `GET /api/admin/users/orphans` pour consultation

## Pré-requis

- Une politique de rétention RGPD-compliant (en lien avec ticket /legal page
  RGPD section "Durée conservation")

## Effort estimé

- 1j

## Référence

- `prisma/schema.prisma` : modèles `User`, `Account`, `Session`
- `CI-ARCHITECTURE.md` §18.3 (crons silencieusement KO)
