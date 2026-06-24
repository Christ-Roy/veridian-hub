# [HUB] 🟡 P1 — Consolider les 2 gardiens d'auth admin : `requireAdmin` vs `authenticateAdmin`

> **Sévérité** : 🟡 P1 (durcissement sécu — 14 routes admin sensibles sans rate-limit ni anti-impersonation)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-25 (HUNT axe 3 — logique d'autorisation dupliquée divergente)

## TL;DR

Deux gardiens d'autorisation admin coexistent en prod et sont **tous deux
activement câblés** :

| Gardien | Fichier | Routes | Protections |
|---|---|---|---|
| `requireAdmin` | `lib/admin/require-admin.ts` | **14** | header secret OU session admin **seulement** |
| `authenticateAdmin` | `lib/admin/authenticate.ts` | **18** | secret + session admin **+ rate-limit (30/min/IP) + anti-ré-impersonation + bypass E2E sécurisé** |

`authenticateAdmin` est la version **durcie** (livrée après l'incident
cascade-429 du 2026-05-23 + le garde-fou anti-ré-impersonation). `requireAdmin`
est la version **simple historique** qui n'a jamais été retirée.

## Le problème de sécurité

Les **14 routes** encore sur `requireAdmin` ne bénéficient PAS de :

1. **Rate-limit** : un attaquant peut bruteforcer `x-admin-secret` sans plafond
   sur ces routes (delete-tenant, grant-plan, suspend/resume notifuse...).
2. **Anti-ré-impersonation** : un admin qui impersonifie un autre admin pourrait
   atteindre ces 14 routes (le check `isImpersonatedSession` n'est appliqué que
   par `authenticateAdmin`).

Routes concernées (toutes mutatives / sensibles) :

```
app/api/admin/users/create
app/api/admin/users/orphans
app/api/admin/users/[email]
app/api/admin/grant-plan
app/api/admin/delete-tenant
app/api/admin/list-tenants
app/api/admin/tenants/link-app
app/api/admin/tenants/unlink-app
app/api/admin/tenants/[id]/plan
app/api/admin/notifuse/update-plan
app/api/admin/notifuse/delete
app/api/admin/notifuse/suspend
app/api/admin/notifuse/resume
app/api/admin/notifuse/status
```

(Note : `users/create`, `users/orphans`, `users/[email]` apparaissent dans les
DEUX listes — à vérifier, double-garde ou migration partielle en cours.)

## La demande

Migrer les 14 routes `requireAdmin` → `authenticateAdmin` (signature différente :
`authenticateAdmin` renvoie `{ ok, response?, sessionEmail? }` au lieu de
`NextResponse | null`), puis **supprimer `require-admin.ts`** pour ne garder
qu'UN seul gardien.

Travail = ~14 routes + leurs 14 tests (chacun mocke `requireAdmin`, à réécrire
sur `authenticateAdmin`). Tier 🔴 (auth) → `pnpm e2e:staging:full` + monitoring
avant promo prod.

## Pourquoi un ticket et pas un fix HUNT direct

Touche 14 routes + 14 tests + un choix d'archi (forme de retour des gardiens) →
trop large pour un quick-win en passant (HUNT abat les <5 min safe, pas les
refactors sécu multi-fichiers). Déposé pour une vague backend dédiée.

## Fait en passant (HUNT 2026-06-25)

Le trou de **test** sur les deux gardiens a été comblé immédiatement (ils
n'avaient AUCUN test alors qu'ils gardent toutes les routes admin) :
- `__tests__/lib/admin/check-admin.test.ts` (isPlatformAdmin sabotage-proof)
- `__tests__/lib/admin/require-admin.test.ts` (4 chemins + garde-fous ADMIN_SECRET)

Ces tests resteront valides après la migration (sauf `require-admin.test.ts` qui
disparaîtra avec le fichier).
