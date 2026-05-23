# [HUB] E2E fix — Trial state machine cron (spec 10)

> **Sévérité** : 🔴 P0 — bloque promo main
> **Owner** : sub-agent Opus dédié, worktree isolé
> **Créé** : 2026-05-23 par team lead après `pnpm e2e:staging:full`

## Specs en échec

`e2e/staging-full/10-trial-state-machine-flow.spec.ts` :
- S4 : cron tick + eligible_at back-dated -49h → state=trial_active + dates
  - Cron renvoie `activated=0, notified=0, expired=0` → le cron ne voit pas la row test
- S5 : trial_active back-dated -13j → ending_soon_notified=true
  - "cron tick doit avoir notifié au moins notre row (J+12 atteint)"
- S7 : trial_ends_at -1j SANS Stripe sub → state=expired + downgrade
  - Idem activated=0
- S9 : race condition (SELECT FOR UPDATE SKIP LOCKED) → 2 calls simultanés
  - Idem la row n'est jamais touchée

## Symptôme

Le cron `/api/cron/trial-tick` (ou équivalent) tourne mais sa query SQL ne sélectionne aucune row test. Causes possibles :

1. **Cron secret** : le test appelle `/api/cron/trial-tick` avec un Bearer, vérifier que `CRON_SECRET` (ou équivalent) côté staging matche ce que la spec envoie
2. **Filtre tenant_id ou app** : la query du cron filtre peut-être sur des conditions que les rows test ne matchent pas (ex: `app=notifuse` AND `plan=trial` AND `eligible_at < NOW() - INTERVAL '48h'`)
3. **Row pas insérée** : le helper SQL de la spec utilise `_sql-helper.ts` qui pourrait avoir un problème d'accès DB (cf ticket spec 11 — même problème)
4. **Table renommée ou colonne ajoutée** récemment (sprint v1.4 ?) : le cron lit peut-être l'ancien nom

## Action attendue

1. Reproduire : `pnpm exec playwright test e2e/staging-full/10-trial-state-machine-flow.spec.ts --reporter=list`
2. Lire les logs container `hub-staging` pendant la spec (cron output structuré)
3. Vérifier le SQL exact exécuté par le cron (`lib/billing/trial-tick.ts` ou équivalent) vs ce que la spec insère
4. Fix le mismatch (peut être côté cron OU côté fixture)
5. Re-tester
6. Push staging

## Contraintes

- Touche au billing → `[risk:medium]`
- Tests Nuclear obligatoires si code modifié
- Vérifier que le fix n'introduit pas de bombe temporelle (utiliser `vi.useFakeTimers` si dates relatives)
