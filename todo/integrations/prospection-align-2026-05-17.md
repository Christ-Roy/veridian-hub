# Ticket Prospection — Alignement contrat Hub v1

> **À copier-coller intégralement dans `veridian-prospection/todo/2026-05-17-hub-contract-alignment.md`**.
>
> **Demandeur** : agent Hub (`veridian-hub`).
> **Priorité** : 🟡 P1 — pas un bug bloquant, mais blocker pour la roadmap "provisioning à la demande" + cohérence Hub.
> **Format réponse attendu** : sous `## Réponse — YYYY-MM-DD` dans le même fichier côté Prospection, puis le déplacer dans `veridian-prospection/todo/done/` une fois mergé.

---

## Contexte business

Le Hub Veridian standardise son contrat d'intégration avec les apps downstream (Notifuse, Prospection, futures). Cf `veridian-hub/todo/integrations/README.md`.

**Aujourd'hui Prospection est `🟡 Partiel`** : provision existe mais avec une signature HMAC custom, pas d'attach-owner, pas de health, pas de webhook standardisé vers Hub. À aligner sur la v1 du contrat.

## État actuel (observé dans le repo Prospection)

| Endpoint | Statut |
|---|---|
| `POST /api/tenants/provision` | ✅ Existe — signature HMAC custom (`hmac_sha256(secret, email + ":" + timestamp)`), à migrer vers standard `hmac_sha256(secret, timestamp + "." + raw_body)` |
| `POST /api/tenants/attach-owner` | ❌ Manque |
| `POST /api/tenants/suspend` | ❌ Manque (mais Hub n'en a pas besoin tant que Stripe webhook→Hub→Prospection pas branché) |
| `POST /api/tenants/resume` | ❌ Manque |
| `GET /api/tenants/{id}/health` | ❌ Manque |
| Webhooks app→Hub | ❌ Manque |

Côté Hub, les appels existants vers Prospection :
- `utils/tenants/provision.ts:594-625` → `POST /api/tenants/provision` au signup (à terme : au click "Activate Prospection")
- `app/api/prospection/regenerate-login/route.ts` → endpoint custom Prospection (à terme : remplacer par `generateMagicLink` standard)
- `app/api/admin/impersonate/route.ts` → endpoint impersonate custom

## Demande — 5 livrables

### Livrable 1 — Migrer la signature HMAC vers le standard

Aujourd'hui côté Hub (`utils/tenants/provision.ts:606-610`) :

```ts
const timestamp = Date.now();
const signature = hmac('sha256', PROSPECTION_SECRET)
  .update(`${email}:${timestamp}`)
  .digest('hex');
```

À remplacer côté Prospection par le middleware HMAC standard (voir Notifuse `internal/http/middleware/veridian_hmac.go` pour le pattern de référence) :

```
X-Veridian-Timestamp: <unix_ms>
X-Veridian-Hub-Signature: <hex(hmac_sha256(secret, "{timestamp}.{raw_body}"))>
```

**Vérification côté Prospection** :
1. Reject si `|now - timestamp| > 5min`
2. Recompute signature avec `HUB_API_SECRET`
3. Compare en temps constant (`crypto.timingSafeEqual`)

**Compatibilité backward** : pendant 2 semaines, accepter **les 2 formats** côté Prospection (détection : header `X-Veridian-Hub-Signature` présent = nouveau format). Coordonner avec agent Hub pour le switch final.

### Livrable 2 — Endpoint `POST /api/tenants/attach-owner`

Identique à la spec Notifuse — cf `veridian-hub/todo/integrations/README.md` section "2. POST /api/tenants/attach-owner".

**Request** :
```json
{
  "tenant_id": "string",
  "owner_email": "string",
  "role": "owner|admin"
}
```

**Response 200** :
```json
{
  "tenant_id": "string",
  "owner_email": "string",
  "user_id": "string",
  "attached": true,
  "already_attached": false,
  "role": "owner"
}
```

Idempotent. Additif. Voir Notifuse ticket pour le détail des cas.

### Livrable 3 — Endpoint `GET /api/tenants/{id}/health`

**Response 200** :
```json
{
  "tenant_id": "string",
  "workspace_id": "string",
  "status": "active|suspended|deleted",
  "owner_attached": true,
  "owner_email": "string",
  "owner_user_id": "string",
  "api_key_valid": true,
  "magic_link_capable": true,
  "members_count": 1,
  "plan": "freemium",
  "checked_at": "ISO8601"
}
```

Le Hub appellera ce endpoint en cron 1×/h.

### Livrable 4 — Endpoints suspend / resume

Même spec que Notifuse. Idempotent. Voir le README intégration.

### Livrable 5 — Webhooks Prospection → Hub

Endpoint Hub à appeler : `POST https://app.veridian.site/api/webhooks/prospection`.

Auth : `Authorization: Bearer <HUB_WEBHOOK_TOKEN_PROSPECTION>` (token statique, à générer + ajouter côté Hub ENV).

Événements obligatoires :

| Event | Quand |
|---|---|
| `tenant.suspended` | Prospection suspend (admin action, quota dépassé) |
| `tenant.resumed` | Prospection resume |
| `tenant.deleted` | Hard delete |
| `tenant.owner_changed` | Admin change l'owner |
| `tenant.quota_exceeded` | Soft alert |

Format :
```json
{
  "event": "tenant.suspended",
  "tenant_id": "string",
  "occurred_at": "ISO8601",
  "data": { "reason": "...", ... },
  "idempotency_key": "uuid v4"
}
```

Retry recommandé en cas de 5xx (backoff exponentiel, max 1h, max 24h total). Le Hub répond 200/409/400.

## Endpoint `generateMagicLink` (optionnel mais recommandé)

Pour remplacer à terme `regenerate-login` custom + le param `loginUrl?t=<token>` propriétaire actuel.

**Auth** : Bearer API key tenant (récupérée par le Hub au provisioning, stockée dans `Tenant.prospectionApiKey`).

**Request** :
```json
{ "user_email": "string" }
```

**Response 200** :
```json
{
  "magic_link": "string (URL signin one-shot)",
  "auto_login_url": "string (URL self-contained TTL 60s)",
  "expires_at": "ISO8601"
}
```

Pas urgent (peut rester en custom v0 pour quelques semaines), mais à terme tous les magic links Hub→app passeront par ce contrat standardisé.

## Tests à ajouter (côté Prospection)

### Tests unitaires

```ts
// Provision attache l'owner
test('provision creates owner in workspace_members', async () => { ... });

// Provision idempotent
test('provision called twice returns created=false', async () => { ... });

// AttachOwner crée user
test('attach-owner creates user if missing', async () => { ... });

// AttachOwner idempotent
test('attach-owner already_attached true on second call', async () => { ... });

// AttachOwner additif
test('attach-owner does not remove existing owner', async () => { ... });

// Health renvoie magic_link_capable=true sur tenant sain
test('health: healthy tenant', async () => { ... });

// Health renvoie magic_link_capable=false si owner détaché
test('health: orphan tenant', async () => { ... });

// HMAC anti-replay
test('rejects HMAC with timestamp > 5min skew', async () => { ... });

// HMAC backward compat (pendant 2 semaines)
test('accepts legacy email:ts HMAC format', async () => { ... });
```

### Test d'intégration `e2e/hub-contract.spec.ts`

Le scénario standard 1-9 du README intégration Hub. Bloquant en CI.

## Versionnement et migration progressive

- **Étape 1** (immédiate, sans breaking) : ajouter `attach-owner`, `health`, webhooks. Garder l'ancien HMAC format en plus.
- **Étape 2** (J+14) : Hub switch sur le nouveau HMAC. Prospection peut dégager l'ancien.
- **Étape 3** (J+30) : Hub commence à appeler `generateMagicLink` standard à la place de `regenerate-login`. Custom legacy dégradé.

## Coordination avec le Hub

Quand les livrables 1-5 sont en prod Prospection, **prévenir l'agent Hub** :

1. Déplacer ce fichier dans `veridian-prospection/todo/done/`.
2. Créer `veridian-hub/todo/from-prospection/2026-XX-XX-contract-v1-ready.md` :
   ```
   # Prospection contract v1 READY (prod)

   - HMAC standard supporté (legacy aussi pour 2 sem)
   - POST /api/tenants/attach-owner exposé
   - GET /api/tenants/{id}/health exposé
   - POST /api/tenants/suspend, /resume exposés
   - Webhooks → /api/webhooks/prospection avec token <token_id_à_communiquer>
   - Test e2e en CI passe
   ```
3. Robert (humain) prévient l'agent Hub.

## Hors-scope explicite

- **Pas de migration des tenants existants** dans ce ticket. Une fois `attach-owner` en prod Prospection, le Hub fera un script repair si nécessaire.
- **Pas de refonte de l'auth Prospection** (toujours Supabase Auth). On standardise juste le contrat avec le Hub.
- **`regenerate-login` peut rester** en parallèle de `generateMagicLink` standard. Le Hub bascule progressivement.

## Code Hub actuel qui devra évoluer

Une fois le contrat v1 dispo côté Prospection, le Hub fera côté son code :

```ts
// veridian-hub/lib/prospection/client.ts (à créer, sur le modèle de lib/notifuse/client.ts)
export class ProspectionClient {
  async provisionWorkspace(...) {} // → POST /api/tenants/provision avec HMAC standard
  async attachOwner(...) {}        // → POST /api/tenants/attach-owner
  async getHealth(tenantId) {}     // → GET /api/tenants/{id}/health
  async suspendWorkspace(...) {}
  async resumeWorkspace(...) {}
  async generateMagicLink(...) {}  // optionnel
}
```

Code legacy `utils/tenants/provision.ts:584-717` sera remplacé par un appel `ProspectionClient.provisionWorkspace(...)`.
