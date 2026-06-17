# [HUB] 🟢 P2 — Activer le push CRM du tunnel en prod (après les presets)

> **Sévérité** : 🟢 P2 (en attente des presets de scoring — cf ticket presets)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17

## Contexte
Le scoring tunnel est en prod et fonctionne (vérifié bout-en-bout). Le PUSH CRM
(prospect chaud → CRM Twenty) est codé (`lib/prospect/push-to-crm.ts`, cron
`push-prospect-scores`) mais NE POUSSE PAS car le routage campagne→CRM n'existe
pas encore. Robert a mis le scoring en STANDBY le temps de poser les presets
configurables (cf todo/2026-06-17-presets-scoring-configurables-avant-push-crm.md).

## Le trou de routage (diagnostiqué 2026-06-17)
Le cron route : `prospect_scores.tenant_uuid → Tenant → CrmTenant.twentyWorkspaceUrl`.
- **0 CrmTenant en prod** (table `crm_tenants` VIDE).
- Le workspace cold de Notifuse n'a **pas de Tenant Hub** (`SELECT ... WHERE
  notifuse_workspace_slug ILIKE '%cold%'` → 0 row). Donc `tenant_uuid` reste null
  → le cron skip gracieusement (outcome `no_crm_tenant`).

## Ce qu'il faut pour activer (quand Robert donnera le GO)
1. **Brancher le CRM de Robert** : la route `app/api/admin/crm/create-tenant`
   PROVISIONNE un NOUVEAU workspace Twenty — elle ne branche pas un CRM existant.
   Pour le CRM cold de Robert (`crm.app.veridian.site`, clé `TWENTY_BEARER_VERIDIAN`
   du bridge, valable jusqu'à 2027-06), il faut soit :
   - une route/script qui INSÈRE une row `crm_tenants` pointant un CRM EXISTANT
     (url + clé chiffrée via `encryptSecret`), OU
   - décider que le CRM cold de Robert n'est pas un "CrmTenant" et router autrement.
   → Décision d'archi à trancher avec Robert.
2. **Créer le Tenant Hub** pour le workspace cold (mapping
   notifuse_workspace_slug → tenants.user_id → CrmTenant).
3. **Passer le cron en DRY_RUN=0** (`CRON_PUSH_DRY_RUN=false` côté compose Hub prod).
4. **DÉBRANCHER le bridge** (`veridian-tunnel-de-vente/bridge`, dev-pub
   `tunnel-bridge`) : il écrit dans le MÊME CRM `crm.app.veridian.site`. Aujourd'hui
   en DRY_RUN=1 (inoffensif). Si le Hub passe en écriture réelle SANS débrancher le
   bridge → risque de double écriture quand le bridge passera lui aussi en réel.
   Le bridge a une souscription Notifuse SÉPARÉE (secret `whsec_zZ...` ≠ Hub
   `a62b5fb7...`) donc pas de conflit de RÉCEPTION, mais bien un risque d'écriture
   double. Couper sa souscription Notifuse + arrêter le container.
5. **Re-rouler `pnpm e2e:tunnel`** (le juge de paix) avant DRY_RUN=0, idéalement
   avec un CrmTenant test, pour couvrir l'écriture Twenty réelle + le stage SCREENING
   (non testables en DRY_RUN).

## Garde-fou
Le bridge reste en DRY_RUN=1 = filet de sécurité. Tant que cette bascule n'est
pas faite, RIEN n'écrit dans le CRM de Robert (ni bridge ni Hub).
