# [HUB] Aligner webhook receiver sur `occurred_at` (contrat §5.18.4)

> **Type** : Bug contrat — naming field webhook
> **Sévérité** : 🟡 P1 — webhook Prosp → Hub silencieusement rejeté en 400
> **Demandeur** : agent Prospection (team-lead sprint v1.5)
> **Créé** : 2026-05-21
> **Découvert** : smoke staging T14 Prospection

## TL;DR

Le webhook `tenant.member_role_changed` envoyé par Prospection vers
`POST /api/webhooks/prospection` Hub est **rejeté en 400** par le Hub
parce que le Hub attend un field `emitted_at` alors que :
- Le contrat (`CONTRAT-HUB.md` lignes 984 et 2246) dit `occurred_at`
- Prospection envoie `occurred_at` (cf `src/lib/hub/webhooks.ts:88-92`)

**Hub est en drift par rapport à son propre contrat.**

## Erreur observée (logs container staging Prosp)

```
[hub-webhook:4xx] event=tenant.member_role_changed status=400
body={"error":"invalid_payload","message":"Missing or invalid required fields: emitted_at"}
```

## Référence contrat

`veridian-hub/docs/CONTRAT-HUB.md` :
- Ligne 984 : `"occurred_at": "ISO8601"`
- Ligne 2246 : `"occurred_at": "ISO8601"`

`veridian-hub/app/api/webhooks/prospection/route.ts:5` :
- Commentaire JSDoc dit `emitted_at`
- Validation Zod (probablement) attend `emitted_at`

## Impact

- Le Hub n'apprend JAMAIS les changements de rôle décidés côté UI Prosp
  (admin change un member → admin via dashboard Prosp)
- Aucune table Hub `hub_app.tenant_members` n'est mise à jour à partir
  de Prosp
- Le retry du webhook Prosp coupe immédiatement (4xx considéré permanent)
- Smoke staging Prosp T14 : tous les autres scénarios cross-app verts
  (19/19), seul ce webhook fail silencieusement côté Hub

## Fix attendu

**Option A (recommandé)** : Hub aligne sur le contrat. Renommer
`emitted_at` → `occurred_at` dans :
- Validation Zod du body dans `app/api/webhooks/prospection/route.ts`
- Code interne qui lit le field
- Tests E2E `/api/webhooks/prospection`

**Option B** : Amender le contrat. Changer `occurred_at` → `emitted_at`
dans `CONTRAT-HUB.md` lignes 984 + 2246, puis Prosp + Notifuse + CMS
patchent leur emit. Plus coûteux (3 apps à modifier).

**Reco** : A. Le contrat est la source de vérité (déjà gravé v1.5,
publié pour les 3 apps). Hub doit s'aligner.

## Validation post-fix

1. Smoke staging Hub : `curl POST hub.staging.veridian.site/api/webhooks/prospection`
   avec body `{event, tenant_id, data, idempotency_key, occurred_at}` →
   200 attendu
2. Smoke réel : refaire le scénario T14 Prosp depuis dashboard admin →
   PATCH member role → webhook émis → 200 côté Hub → vérif table
   `hub_app.tenant_members` mise à jour

## Coordination

- Aucune action requise côté Prosp (déjà conforme).
- Une fois Hub fixé, ping team-lead Prosp pour re-smoke complet T14 et
  débloquer la promo prod Prosp T3 (en attente).

## Référence sprint Prosp

- Smoke T14 : 19/19 endpoints OK, seul drift = ce webhook
- Bundle staging Prosp prêt à promo : T2 attach-member, T3 multi-membre
  (sync/remove/restore/freeze/unfreeze), T7 patch tenant_id email/UUID
