# Trial state machine n'ignore PAS les tenants soft-deleted

> **Sévérité** : 🟡 P1
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Source** : E2E `e2e/staging-full/15-legacy-tenants-paths.spec.ts` Cas 5
> **Risk si on touche** : moyen (logique billing/trial cross-app)

## Contexte

L'E2E `15-legacy-tenants-paths.spec.ts` Cas 5 (test "Trial state machine
ignore les tenants soft-deleted") a confirmé que le cron `trial-tick`
active un trial même sur un tenant dont `deleted_at IS NOT NULL`.

Reproduction E2E :
1. Créer un tenant avec `deleted_at = NOW() - INTERVAL '1 day'`
2. Insérer `tenant_trials (tenant_id, app='notifuse', state='eligible',
   eligible_at=NOW() - INTERVAL '49 hours')`
3. POST `/api/cron/trial-tick` avec `Authorization: Bearer $CRON_SECRET`
4. SELECT state FROM `tenant_trials` → **`trial_active`** au lieu de
   `eligible` (attendu).

## Cause root

`lib/trial/run-tick.ts` — les 3 phases (`processActivations`,
`processEndingSoon`, `processFinalize`) font des `SELECT` sur
`tenant_trials` SANS JOIN sur `tenants` ni filtre `deleted_at IS NULL`.

```sql
-- Code actuel processActivations (équivalent)
SELECT tenant_id, app, eligible_at
FROM hub_app.tenant_trials
WHERE state = 'eligible'
  AND eligible_at <= ${eligibleCutoff}
-- ❌ Manque : AND EXISTS (SELECT 1 FROM hub_app.tenants t
--              WHERE t.notifuse_workspace_slug = tenant_trials.tenant_id
--                AND t.deleted_at IS NULL)
```

## Impact business

- Mails "trial démarré" envoyés à des owners de tenants supprimés
- Mails "trial expire dans 3j" → "trial expiré" envoyés sur tenants morts
- Appel downstream `notifuseClient.updatePlan(plan='pro' puis 'free')`
  sur un workspace probablement déjà nettoyé → 404 silencieux côté apps,
  log d'erreur côté Hub
- Notification Telegram bruyante pour Robert sur des tenants à ignorer

## Fix proposé

Dans `lib/trial/run-tick.ts`, ajouter à chaque phase un filtre :

```sql
AND EXISTS (
  SELECT 1 FROM hub_app.tenants t
  WHERE (
    t.id::text = tenant_trials.tenant_id
    OR t.notifuse_workspace_slug = tenant_trials.tenant_id
    OR t.slug = tenant_trials.tenant_id
  )
  AND t.deleted_at IS NULL
)
```

Le triple OR sur l'identifiant suit la convention `resolveOwnerEmail`
plus bas dans le même fichier (tenant_id peut être un UUID Hub, un slug
Notifuse ou un slug Hub).

## Tests requis (Nuclear)

- `__tests__/lib/trial/run-tick.test.ts` : ajouter cas "skip si tenant
  soft-deleted" pour les 3 phases (activate / ending-soon / finalize).
- `__tests__/lib/trial/run-tick.test.ts` : cas "skip si tenant inexistant"
  (orphan trial row).

## Notes archivage

L'E2E qui révèle le bug **passe quand même** (`expect(stateAfter).toContain(['eligible', 'trial_active'])`) — c'est volontaire pour ne pas bloquer la
suite. Une fois le fix mergé, mettre à jour le test pour exiger STRICTEMENT
`stateAfter === 'eligible'` (et ajouter `test.fail()` temporaire si besoin
pour archiver l'évidence du bug).
