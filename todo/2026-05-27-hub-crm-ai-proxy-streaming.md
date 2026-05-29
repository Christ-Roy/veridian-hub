# [HUB] Proxy AI CRM — spec streaming SSE + comptage tokens

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Complète `todo/2026-05-27-billing-hub-pour-crm.md` (T3 ne traite pas le streaming)
> - Dépend de `todo/2026-05-27-hub-crm-ai-proxy-hmac.md` (auth en amont)
> - Audit `/tmp/audit-crm-needs-2026-05-27.md` §D.2

## Contexte

Anthropic API supporte `stream: true` (SSE) qui est **utilisé par défaut**
par Twenty pour l'UX chat-agent et la génération de texte temps réel. Le
proxy AI Hub (T3 du ticket billing) doit :

1. **Forward le stream** (Edge runtime Next.js, pas buffer en mémoire)
2. **Compter les tokens IN/OUT** sur la trame `message_stop` ou
   `message_delta.usage` qui clôt le stream
3. **Incrémenter `ai_tokens_used_this_period`** **uniquement après**
   stream complet (pas anticipé : si Anthropic 5xx en cours de stream, on
   ne débite rien)
4. **Couper proprement** si quota dépassé en cours de stream (rare mais
   possible si le `prompt_tokens` n'avait pas été pré-estimé)

Sans cette spec, le proxy va soit :
- Buffer tout en mémoire → UX dégradée (latence visible côté Twenty),
  risque OOM si réponse longue
- Forward le stream mais oublier de compter → quota IA inopérant en
  pratique (90%+ des calls IA Twenty sont streams)

## Action attendue

### 1. Architecture du proxy en streaming

```typescript
// app/api/crm-ai-proxy/[provider]/[...path]/route.ts
export const runtime = 'nodejs'; // PAS edge (Anthropic SDK + crypto)
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { provider: string; path: string[] } }) {
  const rawBody = await req.text();
  const { workspaceId } = verifyCrmAiProxyRequest(rawBody, req.headers);

  // 1. Pré-check quota (estimate prompt_tokens via tiktoken/anthropic-tokenizer)
  const estimatedIn = estimatePromptTokens(rawBody);
  const quota = await checkAiQuota(workspaceId);
  if (!quota.allowed || estimatedIn > quota.remaining) {
    return Response.json({ error: 'quota_exhausted', upgradeUrl: `${HUB_URL}/upgrade?plan=crm-business` }, { status: 429 });
  }

  // 2. Forward le stream
  const upstream = await fetch(`${ANTHROPIC_BASE_URL}/${params.path.join('/')}`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
      'content-type': 'application/json',
    },
    body: rawBody,
  });

  if (!upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  }

  // 3. Stream tee : forward au client + parse pour debit final
  const [forStream, forCount] = upstream.body!.tee();

  // Compteur asynchrone (ne bloque pas le forward)
  countTokensFromStream(forCount, workspaceId, params.provider, params.path.join('/'));

  return new Response(forStream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}
```

### 2. Comptage SSE Anthropic

```typescript
async function countTokensFromStream(
  stream: ReadableStream<Uint8Array>,
  workspaceId: string,
  provider: string,
  path: string,
): Promise<void> {
  let promptTokens = 0;
  let completionTokens = 0;
  let model = 'unknown';

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames "event: ...\ndata: {...}\n\n"
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const json = JSON.parse(dataLine.slice(6));
          if (json.type === 'message_start' && json.message?.usage) {
            promptTokens = json.message.usage.input_tokens ?? 0;
            model = json.message.model ?? model;
          }
          if (json.type === 'message_delta' && json.usage) {
            completionTokens = json.usage.output_tokens ?? completionTokens;
          }
          if (json.type === 'message_stop') {
            // Final flush
            await incrementAiUsage(workspaceId, promptTokens, completionTokens, model);
            await writeAuditLog('admin.crm.ai-proxy.call', { workspaceId, provider, path, promptTokens, completionTokens, model, status: 'ok' });
            return;
          }
        } catch (e) {
          // ignore parse errors on partial frames
        }
      }
    }
  } catch (err) {
    console.error('[CRM AI Proxy] stream count error', err);
    await writeAuditLog('admin.crm.ai-proxy.call', { workspaceId, provider, path, promptTokens, completionTokens, model, status: 'stream_error', error: String(err) });
  }
}
```

### 3. Non-streaming (fallback OpenAI / requêtes sans `stream:true`)

Si la requête ne contient PAS `"stream":true` dans le body :
- Forward classique, attendre la response complète
- Lire `response.body.usage` (Anthropic/OpenAI exposent `usage.input_tokens`/`output_tokens`)
- `incrementAiUsage` synchrone
- Audit log

### 4. Edge cases à couvrir

| Cas | Comportement attendu |
|---|---|
| Stream interrompu côté client (user ferme onglet) | `tee()` continue de couler côté comptage. Audit log avec partial tokens si jamais `message_stop` n'arrive pas (timeout 60s) |
| Anthropic 429 (rate limit Anthropic, pas Hub) | Passthrough du 429 vers Twenty. Pas de débit côté Hub (rien consommé). Audit log avec `status: 'upstream_429'` |
| Anthropic 5xx | Passthrough. Pas de débit. Audit log `status: 'upstream_5xx'` |
| Quota dépassé en cours de stream (estimate était sous-évalué) | On laisse finir le stream courant (UX), debit final déborde le quota → flag `over_quota: true` dans audit, et `checkAiQuota` retournera `false` au prochain call |
| Réponse > 1 MB en non-streaming | Continue normalement, mais log un warning si > 10 MB (indicateur de bug Twenty) |

### 5. Pre-token estimation

Pour le pré-check (avant forward), utiliser un tokenizer light :
- Anthropic : pas de SDK tokenizer public officiel. Approximation `chars / 4`
  avec marge +20% (acceptable car c'est un pré-check, pas la valeur de debit
  finale)
- OpenAI : `tiktoken` (déjà packagé npm)

Le pré-check sert juste à éviter de payer Anthropic si l'user est sec.
La vraie comptabilité = sur la trame `message_stop`.

### 6. Streaming OpenAI

OpenAI a un format SSE différent (`data: {...}\n\n` puis `data: [DONE]\n\n`).
Le champ `usage` est dans le **dernier chunk avant `[DONE]`** si on a
passé `stream_options: { include_usage: true }`. Sinon, fallback estimate.

Pour la vague 3, on peut commencer **Anthropic uniquement** (Twenty utilise
Anthropic en default). OpenAI à câbler vague 4 avec le même pattern adapté.

## Tests / DoD

- [ ] Test E2E avec mock Anthropic stream :
  - Stream 5 frames `content_block_delta` + 1 `message_stop` → tokens comptés correctement
  - Stream interrompu après 3 frames → audit log `stream_error`
- [ ] Test E2E non-streaming :
  - Requête sans `stream:true` → response complète + `incrementAiUsage` appelé une fois
- [ ] Test quota :
  - Workspace à 99% quota → 200 + stream OK, mais next call → 429
  - Workspace à 100%+ quota → 429 immédiat sans forward
- [ ] Test passthrough erreur upstream :
  - Anthropic mock 5xx → 5xx forwarded, pas de débit, audit `upstream_5xx`
  - Anthropic mock 429 → 429 forwarded, pas de débit, audit `upstream_429`
- [ ] Test forward stream sans buffer (mesurer TTFB < 200ms vs 2s+ si bufferisé)
- [ ] Audit log écrit pour chaque appel (success + error)
- [ ] Documentation `docs/CRM-INTEGRATION.md` : section "AI Proxy Streaming"
  avec exemples curl + format usage Anthropic

## Non-objectifs

- ❌ Streaming OpenAI complet (vague 4)
- ❌ Compter le coût en € au moment du debit (séparé : cf ticket cost-circuit-breaker)
- ❌ Cache de réponses identiques (pas pertinent pour LLM stateful)
- ❌ Implémenter `incrementAiUsage` (déjà couvert billing T2)
