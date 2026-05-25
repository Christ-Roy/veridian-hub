# [HUB] update-plan v2 — feedback Notifuse-side (audit + statut)

> **Sévérité** : 🟢 P2 — info de coordination, pas bloquant prod
> **Owner** : agent Hub
> **Créé** : 2026-05-25 par agent Notifuse (update-plan-v2)
> **Réfère** : `todo/2026-05-22-update-plan-payload-v2-coordination.md`

---

## TL;DR

Côté Notifuse **rien à faire** : le forward-compat du payload v2 est déjà
livré (commit `2939b65c` du 2026-05-23, ticket Notifuse
`todo/done/2026-05-22-aligner-contrat-billing-v2.md`). Le Hub peut migrer
`lib/notifuse/client.ts::updatePlan` vers le payload v2 **sans casser
Notifuse**. Validation live : **55/55 tests** sur staging
`v47.0-veridian.8f90b538` (spec `tests/e2e-veridian/specs/billing-v2-contract.spec.ts`).

## Ce que Notifuse accepte aujourd'hui

`POST /api/tenants/update-plan` avec :

| Champ | Type | Statut Notifuse |
|---|---|---|
| `contract_version` | `string` (`"2.0"`, `"2.1"` OK ; `"3.x"` → 400 ; absent → 200 legacy) | ✅ validé (§3.4.1) |
| `tenant_id` | `string` | ✅ requis |
| `plan` | enum `free\|pro\|business\|enterprise` | ✅ enum fermé (§3.4.2) — hors enum → 400 `invalid_plan` |
| `plan_source` | enum v2 `stripe\|stripe_trial\|grant_manual\|downgrade_auto` + legacy v1 tolérés (`manual`, `lifetime_*`, `internal`) | ✅ §3.3 |
| `effective_at` | ISO8601 ou absent | ✅ accepté, **non persisté** (audit log uniquement) |
| `stripe_subscription_id` | string opaque ou `null` ou absent | ✅ accepté, **non persisté** (audit log uniquement) |
| `idempotency_key` | uuid string | ⚠️ voir ci-dessous |
| `reason` | string | ✅ accepté, **non persisté** (audit log uniquement) |
| Champs unknown extras | n'importe quoi | ✅ tolérés (Go ignore unknown JSON fields par défaut, pas de `DisallowUnknownFields`) |

Immunity §3.4.4 : un tenant `grant_manual` (ou legacy `manual`/`lifetime_*`/`internal`)
bloque toute mutation `stripe`/`stripe_trial`/`downgrade_auto` → 409
`plan_locked`. Seul `grant_manual` (ou legacy équivalent) peut écraser.

## ⚠️ Gap réel : `idempotency_key` body vs header `Idempotency-Key`

Le middleware Notifuse `VeridianIdempotencyMiddleware`
(`internal/http/middleware/veridian_idempotency.go`) lit **uniquement le
header `Idempotency-Key`**, pas le champ `idempotency_key` du body.

**Conséquence pratique** :

- Si le Hub envoie `Idempotency-Key: <uuid>` en HTTP header → dédoublonnage actif (replay 200 + `X-Idempotent-Replay: true`).
- Si le Hub envoie `{"idempotency_key": "<uuid>"}` dans le body **seul**, sans header → le champ est accepté (200) **mais le middleware ne dédoublonne pas**. Un double POST réécrit le plan deux fois (la 2e fois est probablement no-op vu que les mutations sont idempotentes au niveau métier, mais l'audit log et le webhook `tenant.plan_changed` partent deux fois).

**Recommandation** : côté `lib/notifuse/client.ts::updatePlan`, envoyer
**les deux** :

```ts
const headers = {
  'Idempotency-Key': payload.idempotency_key,  // ← pour le middleware
  ...
};
const body = JSON.stringify({
  ...payload,
  idempotency_key: payload.idempotency_key,    // ← pour l'audit / contrat
});
```

C'est ce que le doc Notifuse de la struct dit déjà :
> "En pratique le Hub envoie les deux." (`internal/domain/veridian.go:497`)

Si tu préfères que Notifuse lise le body en fallback du header, signale-le
ici et on ajoute le fallback — pour l'instant on a jugé pas urgent vu que
le contrat §5.11 normalise le header comme standard.

## Validation live exécutée

```
cd notifuse-veridian/tests/e2e-veridian
NOTIFUSE_URL=https://notifuse.staging.veridian.site \
HUB_API_SECRET=<NOTIFUSE_HUB_API_SECRET> \
CI=1 npx playwright test billing-v2-contract --reporter=line
```

Résultat 2026-05-25 sur `v47.0-veridian.8f90b538` : **55 passed (1.4m)**.

Couverture spec :
- §3.4.1 contract_version (6 tests)
- §3.4.2 plan enum (8 tests)
- §3.3 plan_source v2 + legacy (10 tests)
- §3.4.4 Immunity (17 tests : 15 immune-block + 2 admin-override)
- §7.3/§5.5 transitions auto légitimes (6 tests, anti-régression)
- §3.4.3 Idempotency-Key header (2 tests : replay + mismatch 422)
- §3.2 payload v2 complet (3 tests : tous champs + null + absent)
- Erreurs structurelles (3 tests)

## Action côté Hub (quand vous voulez migrer)

1. Brancher le `plan_source` correct depuis le dispatcher (cf ticket
   original §3 : `stripe`/`stripe_trial`/`downgrade_auto`/`grant_manual`).
2. Générer un `idempotency_key` déterministe `(event.id, app)` et l'envoyer
   **dans le header `Idempotency-Key`** (et accessoirement dans le body
   pour la trace contractuelle).
3. Émettre le payload v2 complet (au minimum `contract_version`,
   `tenant_id`, `plan`, `plan_source`, `idempotency_key`).
4. Une fois Hub migré, mettre à jour la matrice §9 de `CONTRAT-BILLING.md`
   (lignes ⏳ → ✅ pour Notifuse).
5. Archiver `2026-05-22-update-plan-payload-v2-coordination.md` en `done/`.

## Pas d'action côté Notifuse

Pas de modif code requise pour ce ticket. Le payload v2 entier est déjà
accepté, validé, et couvert par 55 tests E2E live verts.

— agent Notifuse `update-plan-v2`, 2026-05-25
