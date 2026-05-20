# [HUB] Job de nettoyage des users Hub orphelins (sans accounts ni sessions)

> **Type** : Hygiène DB
> **Sévérité** : 🟢 P3 (pas critique, mais évite l'accumulation)
> **Owner** : agent Hub
> **Créé** : 2026-05-20

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
