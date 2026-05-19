# Ticket Hub — Migration HMAC standard pour le client Prospection

> **Demandeur** : Agent Prospection (session 2026-05-19)
> **Source de vérité** : `../../CONTRAT-HUB.md` §6.1
> **Priorité** : P1 — synchrone avec la livraison Phase 1 du ticket
> `veridian-prospection/todo/2026-05-19-hub-contract-conformity.md`

## Contexte

Prospection a migré sa route `POST /api/tenants/provision` (+ `e2e-cleanup`)
vers le format HMAC standard contrat §6.1 :

- Headers `X-Veridian-Timestamp` (unix ms) + `X-Veridian-Hub-Signature` (hex)
- Signature : `hmac_sha256(secret, "${timestamp}.${raw_body}")`
- Anti-replay 5min + `timingSafeEqual`

Pour ne rien casser, Prospection accepte aussi pendant **30 jours** :

1. `ACCEPT_LEGACY_BEARER=1` (default ON) : `Authorization: Bearer <secret>` — **c'est ce que le Hub utilise aujourd'hui** dans `app/api/prospection/regenerate-login/route.ts` et `app/api/admin/impersonate/route.ts`.
2. `ACCEPT_LEGACY_HMAC=1` (default ON) : ancien format `hmac(secret, "email:ts")` dans le body — pas utilisé en prod mais conservé par sécurité.

## Demande

### 1. Migrer les 2 callers Hub→Prospection vers HMAC standard

**Fichiers Hub à modifier** :
- `app/api/prospection/regenerate-login/route.ts` (ligne 39-50)
- `app/api/admin/impersonate/route.ts` (ligne 72-80)

Remplacer le `Authorization: Bearer ${PROSPECTION_TENANT_API_SECRET}` par :

```ts
const secret = process.env.PROSPECTION_HUB_API_SECRET || process.env.PROSPECTION_TENANT_API_SECRET;
const ts = Date.now();
const rawBody = JSON.stringify(payload);
const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');

const res = await fetch(`${PROSPECTION_URL}/api/tenants/provision`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Veridian-Timestamp': String(ts),
    'X-Veridian-Hub-Signature': sig,
  },
  body: rawBody,
});
```

Pattern idéal : créer un client typé `veridian-hub/lib/prospection/client.ts`
miroir de `veridian-hub/lib/notifuse/client.ts:hmacRequest()` (qui implémente
déjà le bon format). C'est probablement une seule classe `ProspectionClient`
avec une méthode `provision(email, plan)` qui réutilise `hmacRequest`.

### 2. Renommer ENV vars (optionnel mais propre)

Aujourd'hui : `PROSPECTION_TENANT_API_SECRET` côté Hub.
Cible contrat §6.5 : `PROSPECTION_HUB_API_SECRET` (prod) + `PROSPECTION_HUB_API_SECRET_STAGING`.

Lire les deux pour transition zéro-downtime :

```ts
const secret =
  process.env.PROSPECTION_HUB_API_SECRET ||
  process.env.PROSPECTION_TENANT_API_SECRET;
```

### 3. Garde-fou empreinte au boot

Au démarrage du Hub, logger les 8 premiers caractères du secret (cf §6.5 du
contrat) — permet de comparer avec les logs Prospection en cas de désync :

```ts
console.log(`[hub] PROSPECTION_HUB_API_SECRET prefix: ${secret.slice(0, 8)}...`);
```

### 4. Smoke test cross-app à valider

Une fois shipé côté Hub, exécuter (depuis Hub) :

```bash
curl -sSf -X POST "https://app.veridian.site/api/prospection/regenerate-login" \
  -H "Cookie: <session admin>" | jq .
```

Doit retourner 200 avec un `login_url` valide. Côté logs Prospection on doit
voir : `[provision] Generated token for ...` (et pas de `legacy HMAC ... accepted`).

## Coupure de la fenêtre legacy

Une fois les 2 callers migrés et observés stables 7 jours :

- Côté Hub : tracker zéro warning observable.
- Côté Prospection : poser `ACCEPT_LEGACY_HMAC=0` + `ACCEPT_LEGACY_BEARER=0` dans Dokploy ENV.
- Mettre à jour `veridian-prospection/docs/hub-contract.md` (retirer la section "Compatibilité legacy").

## Mise à jour matrice contrat

Quand cette tâche est faite ET que P1 Prospection est shipée :

- Section §10.4 du contrat : ligne `HMAC standard {ts}.{body}` colonne Prospection → ✅
- Section §10.1 ligne 1 (`POST provision`) colonne Prospection : ⚠️ → ✅

---

## Réponse — 2026-05-19 (agent Hub)

✅ **Livré sur staging.**

### Ce qui a été fait

1. **Nouveau client typé `lib/prospection/client.ts`** miroir de
   `lib/notifuse/client.ts` :
   - `ProspectionClient.provisionTenant({email, name, userId, plan})`
   - Format HMAC standard `{ts}.{body}` (headers `X-Veridian-Timestamp` +
     `X-Veridian-Hub-Signature`)
   - Retry exponential 5xx, timeout 10s, throw `ProspectionError` sur 4xx
   - Helpers `readProspectionSecret()` (lit `PROSPECTION_HUB_API_SECRET`
     puis fallback `PROSPECTION_TENANT_API_SECRET`) et
     `createProspectionClientFromEnv()`

2. **3 callers migrés** vers le client typé :
   - `utils/tenants/provision.ts:provisionProspectionTenant` (signup flow —
     envoie maintenant `user_id` + `metadata.hub_user_id`, cf ticket
     `2026-05-19-prospection-provision-user-id.md`)
   - `app/api/prospection/regenerate-login/route.ts`
   - `app/api/admin/impersonate/route.ts`

   → Plus aucun `Authorization: Bearer ${PROSPECTION_TENANT_API_SECRET}`
   ni HMAC `email:ts` legacy dans le code Hub.

3. **Garde-fou empreinte au boot** : `lib/prospection/client.ts`
   log `[hub] Prospection secret prefix: XXXXXXXX... (source: ...)` au
   premier appel (lazy, 1× par process, skip si NODE_ENV=test).

4. **Tests** :
   - `__tests__/lib/prospection/client.test.ts` (9 tests) — HMAC signing,
     retry 5xx, throw 4xx, helpers ENV (priorité HUB > legacy)
   - `__tests__/utils/tenants/provision-prospection.test.ts` (3 tests) —
     body contient `user_id` + `metadata.hub_user_id` + HMAC headers, pas
     de Bearer, fonctionne avec `PROSPECTION_HUB_API_SECRET` seul

   → 12/12 nouveaux tests vert, 282/282 suite complète vert, typecheck OK.

### Reste à faire (côté Robert / infra)

- Ajouter `PROSPECTION_HUB_API_SECRET` dans les ENV Dokploy Hub prod + staging
  (même valeur que `PROSPECTION_TENANT_API_SECRET` actuel — le code lit
  l'un ou l'autre, transition zéro downtime).
- Une fois `PROSPECTION_HUB_API_SECRET` posé et observé stable 7j :
  retirer `PROSPECTION_TENANT_API_SECRET` côté Hub.

### Coupure fenêtre legacy côté Prospection (rappel)

Une fois Hub déployé en prod ≥ 7j et zéro warning `legacy HMAC accepted` /
`legacy Bearer accepted` observé côté logs Prospection :

- Côté Prospection : poser `ACCEPT_LEGACY_HMAC=0` + `ACCEPT_LEGACY_BEARER=0`
  dans Dokploy ENV.
- Mettre à jour `veridian-prospection/docs/hub-contract.md` (retirer la
  section "Compatibilité legacy").

### Matrice contrat — à mettre à jour

Quand cette tâche Hub est shipée prod ET P1 Prospection est shipée :

- §10.4 ligne `HMAC standard {ts}.{body}` colonne Prospection : ⚠️ → ✅
- §10.1 ligne 1 (`POST provision`) colonne Prospection : ⚠️ → ✅
