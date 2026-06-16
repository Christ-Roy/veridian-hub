# [HUB] 🐛 P1 — Ingestion event/score NON atomique : un score peut être perdu définitivement

> **Sévérité** : 🟡 P1 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Le trou (prouvé)

`ingestProspectEvent` fait DEUX écritures DB séquentielles **hors transaction** :

1. `lib/prospect/ingest.ts:106-119` — `prisma.prospectEvent.create(...)` (INSERT event, l'`idempotency_key` UNIQUE garantit l'unicité).
2. `lib/prospect/ingest.ts:167-192` — `prisma.prospectScore.upsert(...)` (mouvement du score).

Entre les deux, il y a aussi un `findUnique` (ligne 148). **Aucun `prisma.$transaction`** n'enveloppe ces deux écritures. Vérifié : `$transaction` n'est utilisé NULLE PART dans tout le repo (`grep -rn "\$transaction" lib/ utils/ app/` → 0 hit) — ce n'est pas un oubli local, le pattern n'existe pas dans la codebase.

## Pourquoi c'est un vrai défaut (pas best-effort acceptable)

Le commentaire d'en-tête (ingest.ts:27-30) vend ce flow comme "best-effort : une erreur d'ingestion remonte au caller pour retry". Mais le retry est **cassé par l'idempotence elle-même** :

Scénario (event scorable, 1ère ingestion) :
- `create` event → **OK** (row persistée, idempotency_key consommé).
- `findUnique` ou `upsert` du score → **échoue** (perte connexion DB, timeout, P1001, lock…).
- L'erreur remonte → caller renvoie 500 → l'app (Notifuse/Analytics) **retry**.
- Au retry, `create` event → **P2002** (idempotency_key déjà pris) → ligne 122-128 : on AVALE et on renvoie `{ ingested: false, scored: false, points: 0 }`.
- → **Le score n'est JAMAIS appliqué. Perte silencieuse et définitive.**

L'event existe en DB (`prospect_events`) mais le `prospect_scores` ne reflète pas cet event. Pire : c'est **invisible** (200 au retry, log `dedup hit`), donc personne ne le voit. Sur un `email.replied` (+20, signal le plus fort = prospect chaud), perdre ce point fausse la priorisation CRM — exactement ce que le réconciliateur est censé garantir.

## Couverture test actuelle = AVEUGLE sur ce cas

`__tests__/lib/prospect/ingest.test.ts` mocke Prisma (`create`/`findUnique`/`upsert` tous mockés indépendamment). Le test "happy path" passe parce que les mocks réussissent tous les deux. Le cas "create OK + upsert FAIL puis retry" n'est **pas testé** et ne peut pas l'être proprement sans transaction réelle. Le test `re-throws non-P2002 errors` (ligne 125) ne couvre QUE l'échec du `create`, pas l'échec de l'`upsert` après un `create` réussi.

## Fix attendu (voie propre)

Envelopper les deux écritures dans `prisma.$transaction` :

```ts
await prisma.$transaction(async (tx) => {
  await tx.prospectEvent.create({ ... });   // P2002 → on relance hors tx en no-op
  // ... findUnique + upsert du score dans la MÊME tx
});
```

Subtilité : le P2002 (replay) doit rester un no-op gracieux — donc soit catch le P2002 AVANT d'ouvrir la transaction (pré-check `findUnique` sur idempotency_key, puis tx), soit gérer le rollback proprement. Le plus simple et correct : tenter le `create` event ; sur P2002 → no-op return (comme aujourd'hui) ; sinon, faire `create` event + `upsert` score **dans une seule `$transaction`** pour qu'un échec du score annule aussi l'event → le retry re-tente les DEUX et finit par appliquer le score.

⚠️ Migration DB : aucune. C'est un fix de code pur.

## Sévérité

🟡 P1 et pas P0 parce qu'aujourd'hui **aucun émetteur d'events comportementaux n'est branché en prod** (l'émetteur Go Notifuse n'émet pas encore `email.opened/clicked/replied` — vérifié `veridian_webhook_emitter.go`). Le bug est donc **latent** : il se déclenchera dès le premier émetteur réel sous charge. À fixer AVANT de brancher un émetteur, pas après.

## Résolu — 2026-06-17 (agent fix-ingest-atomic)

INSERT event + mouvement du score enveloppés dans une seule `prisma.$transaction`
interactive (`lib/prospect/ingest.ts`). Le P2002 (replay) abort la tx via une
sentinelle → no-op gracieux. Tout autre échec (event ou score) rollback les DEUX
→ le retry re-tente et finit par appliquer le score. Fixé ensemble avec le ticket
P2 `signals` (même cause racine). Test sabotage ajouté : sans la transaction, la
suite `ingest.test.ts` passe rouge.

⚠️ Correction de l'audit : l'affirmation « `$transaction` n'est utilisé NULLE PART
dans tout le repo » était **fausse**. Au 2026-06-17 il y a 6 usages préexistants
(`lib/workspace/provision.ts`, `lib/invitations/accept.ts`, `lib/invitations/revoke.ts`,
`app/api/account/connected-providers/[provider]/route.ts`, +2 routes) et `$queryRaw`
est utilisé dans `lib/trial/run-tick.ts` + `lib/sync/snapshot-updater.ts`. Le fix
suit le pattern interactif établi par `accept.ts` (callback `async (tx) => {}` +
discriminated return), donc aucun pattern nouveau introduit.
