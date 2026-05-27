# [HUB] Spec HMAC du proxy AI CRM (sécurise l'endpoint)

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Bloque la mise en prod du proxy AI défini dans `todo/2026-05-27-billing-hub-pour-crm.md` (T3)
> - Audit cross-app `/tmp/audit-crm-needs-2026-05-27.md` §D.2 + §A.3
> - Pattern miroir : `lib/notifuse/client.ts` (HMAC Hub→Notifuse) + `lib/billing/billing-state-hmac.ts`

## Contexte

Le ticket `billing-hub-pour-crm.md` (T3) introduit une route Hub :

```
POST /api/crm-ai-proxy/[provider]/[...path]
```

dont le rôle est d'intercepter les calls IA Twenty (configurés via
`AI_PROVIDERS.baseUrl`) avant qu'ils n'atteignent Anthropic/OpenAI. Le
proxy applique le quota mensuel par workspace puis forward la requête
avec la **vraie clé Veridian** server-side.

⚠️ **Problème** : sans authentification stricte de l'appelant, cette
route est un **open relay vers Anthropic** avec la clé Veridian — quiconque
connaît l'URL peut consommer le budget Anthropic du Hub. Le ticket T3
mentionne "HMAC signature dans le header" mais ne définit ni le format
ni le secret.

Ce ticket grave la **spec HMAC complète** entre Twenty CRM et le proxy
Hub. **Sans cette spec, T3 ne doit pas être mergé en prod.**

## Action attendue

### 1. Génération du secret partagé

ENV à ajouter côté Hub **et** côté compose Twenty CRM (staging + prod) :

```bash
CRM_AI_PROXY_SHARED_SECRET=<32 bytes hex, généré via `openssl rand -hex 32`>
```

Stockage :
- Hub : Dokploy compose env (encrypted) + `~/credentials/.all-creds.env`
- Twenty CRM : injecté dans compose Twenty via ENV avant build (intégré
  dans la chaîne build Twenty, à coordonner via ticket dans
  `veridian-crm-repo/todo/` car le compose Twenty n'est pas modifiable
  depuis Hub)
- Pas de checkin dans le repo, jamais loggué

### 2. Format des headers HMAC (identique au pattern Notifuse)

Chaque requête Twenty → Hub doit porter :

```
X-Veridian-Timestamp: <unix ms, ex 1748345678901>
X-Veridian-Crm-Signature: <hex(hmac_sha256(secret, "<timestamp>.<rawBody>"))>
X-Veridian-Workspace-Id: <UUID workspace Twenty, ex a89ddd99-960b-46a4-a6a6-1696b02cd9c5>
```

`rawBody` = le corps JSON littéral envoyé (avant parse). Pour un GET sans
body, signer `<timestamp>.` (chaîne vide après le dot).

Le `X-Veridian-Workspace-Id` est **non secret** mais c'est lui qui sert à
identifier quel `crm_tenants.twenty_workspace_id` débiter. Le HMAC le
protège contre la falsification.

### 3. Vérification côté Hub (`lib/crm/ai-proxy-auth.ts`)

```typescript
export function verifyCrmAiProxyRequest(
  rawBody: string,
  headers: Headers,
): { workspaceId: string } {
  const ts = headers.get('X-Veridian-Timestamp');
  const sig = headers.get('X-Veridian-Crm-Signature');
  const workspaceId = headers.get('X-Veridian-Workspace-Id');

  if (!ts || !sig || !workspaceId) throw new Unauthorized('missing_hmac_headers');
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new Unauthorized('clock_skew');
  if (!UUID_REGEX.test(workspaceId)) throw new Unauthorized('bad_workspace_id');

  const expected = createHmac('sha256', process.env.CRM_AI_PROXY_SHARED_SECRET!)
    .update(`${ts}.${rawBody}`)
    .digest('hex');

  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Unauthorized('bad_signature');
  }

  return { workspaceId };
}
```

À appeler en première ligne de `app/api/crm-ai-proxy/[provider]/[...path]/route.ts`.

### 4. Rate limit + IP allowlist (defense in depth)

En complément du HMAC :
- **Rate limit** : 30 req / min / workspace (clé Redis :
  `crm-ai-proxy:rl:<workspaceId>`) — pattern existant via
  `lib/rate-limit/` si présent, sinon Upstash
- **Optionnel prod** : IP allowlist limité aux IPs du serveur Twenty CRM
  prod (cf compose). Le HMAC reste obligatoire même IP allowlisted

### 5. Cross-check côté `crm_tenants`

Avant de forwarder vers Anthropic :
- `SELECT * FROM crm_tenants WHERE twenty_workspace_id = $workspaceId AND status = 'active'`
- Si pas trouvé / suspended → 403 `tenant_inactive`
- Sinon → check quota AI (cf billing T2 `checkAiQuota`)

### 6. Audit log obligatoire

Chaque requête HMAC-validée écrit un audit log :

```
admin.crm.ai-proxy.call
  workspace_id, provider, path, prompt_tokens?, completion_tokens?, model, status
```

Stocké dans `audit_logs` (pattern existant Hub). En cas de rejection HMAC,
audit `admin.crm.ai-proxy.reject` avec raison (`clock_skew`,
`bad_signature`, etc.) — sert au monitoring d'intrusion.

### 7. Rotation du secret

Procédure documentée dans `docs/CRM-INTEGRATION.md` :
1. Generate `CRM_AI_PROXY_SHARED_SECRET_NEW`
2. Hub accepte transitoirement les 2 secrets pendant 10 min (env var
   `CRM_AI_PROXY_SHARED_SECRET_PREVIOUS`)
3. Update ENV côté Twenty CRM, redeploy
4. Retirer `_PREVIOUS` côté Hub

## Tests / DoD

- [ ] Test unitaire `verifyCrmAiProxyRequest` :
  - Requête valide (signature OK, ts récent, workspace UUID) → returns `{workspaceId}`
  - Headers manquants → throws `missing_hmac_headers`
  - Timestamp +6 min décalé → throws `clock_skew`
  - Signature falsifiée → throws `bad_signature`
  - `workspace_id` non UUID → throws `bad_workspace_id`
- [ ] Test contractuel : client mock signant comme Twenty CRM le ferait,
  hit la vraie route → 200 (avec mock Anthropic stub)
- [ ] Test rate limit : 31e requête / min / workspace → 429
- [ ] Test cross-check tenant : workspace inconnu → 403
- [ ] Test cross-check tenant : status=suspended → 403
- [ ] Audit log écrit pour chaque appel (success ET reject)
- [ ] Doc rotation secret dans `docs/CRM-INTEGRATION.md`
- [ ] Ticket coordonné côté `veridian-crm-repo/todo/` pour injecter
  `CRM_AI_PROXY_SHARED_SECRET` dans le compose Twenty CRM + signer les
  calls `/api/ai/*` (déposé via SendMessage team-lead, pas créé soi-même)

## Non-objectifs

- ❌ Implémenter le proxy AI lui-même (c'est T3 du ticket billing-hub-pour-crm)
- ❌ Modifier le code Twenty CRM (ticket séparé dans veridian-crm-repo)
- ❌ mTLS (overkill, HMAC + rate limit + IP allowlist suffisent)
- ❌ JWT au lieu de HMAC (cohérence avec pattern Notifuse/Prospection)
