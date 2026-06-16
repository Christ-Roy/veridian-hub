# [HUB] 🟢 P2 — Créer la route réceptrice `/api/webhooks/analytics` (page.hit) — elle n'existe pas

> **Sévérité** : 🟢 P2
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (audit cohérence réconciliateur, agent audit-crossapp)

## TL;DR
Le réconciliateur (Lot 1 prod) sait ingérer et scorer un `page.hit` (+3, signal
`page_hit`), mais **la route HTTP qui le reçoit n'existe pas**. Analytics ne peut
donc rien envoyer même quand il émettra. C'est un trou côté Hub, dans notre scope.

## Preuve (vérifiée 2026-06-17)
- `app/api/webhooks/` = `notifuse/` + `prospection/` + `route.ts` (Stripe).
  **Pas de `analytics/`.**
- Pas de `lib/webhooks/analytics-handlers.ts`. Seul `notifuse-handlers.ts`,
  `prospection-handlers.ts`, `receiver.ts`.
- Le seul « analytics » dans le code webhook = un commentaire promesse
  (`lib/webhooks/notifuse-handlers.ts:208` : « Analytics (page.hit) arrivera par
  sa propre route /api/webhooks/analytics »).
- En face, tout est PRÊT : `lib/prospect/scoring.ts` cote `page.hit: 3` +
  signal `page_hit` ; `lib/prospect/ingest.ts` gère `app: 'analytics'` ;
  `lib/webhooks/receiver.ts` (`handleWebhook`) est générique multi-app ;
  contrat `docs/CONTRAT-HUB.md §7.5.2` décrit le câblage exact (« Rien d'autre »).
- Donc : **seul le point d'entrée HTTP manque.** Petit ticket, gros débloquage.

## Demande précise (quoi coder, où)
1. **`app/api/webhooks/analytics/route.ts`** — calqué sur la voie Bearer de
   `app/api/webhooks/notifuse/route.ts` :
   ```ts
   export const runtime = 'nodejs';
   export const dynamic = 'force-dynamic';
   export async function POST(request: NextRequest) {
     const token = process.env.ANALYTICS_WEBHOOK_TOKEN;
     if (!token) return NextResponse.json(
       { error: 'internal_error', message: 'ANALYTICS_WEBHOOK_TOKEN not configured' },
       { status: 500 });
     return handleWebhook(request, {
       app: 'analytics',
       expectedToken: token,
       handlers: v14AnalyticsHandlers,
     });
   }
   ```
2. **`lib/webhooks/analytics-handlers.ts`** — un handler `page.hit` :
   ```ts
   export const v14AnalyticsHandlers: HandlerTable = {
     'page.hit': async (payload) => {
       const d = payload.data ?? {};
       await ingestProspectEvent({
         app: 'analytics',
         eventType: 'page.hit',
         workspaceSlug: payload.tenant_id,
         idempotencyKey: payload.idempotency_key,
         occurredAt: payload.occurred_at,
         contactEmail: typeof d.contact_email === 'string' ? d.contact_email : null,
         vid: typeof d.vid === 'string' ? d.vid : null,
         data: payload.data ?? null,
       });
     },
   };
   ```
3. **Câbler `ANALYTICS_WEBHOOK_TOKEN`** : compose Hub (`${ANALYTICS_WEBHOOK_TOKEN:?}`)
   + workflow CI (secret → env → heredoc `.env`) + `.env.example`, dans le **même
   commit** (cf memory `feedback_env_wire_compose_same_commit`). Même valeur côté
   Analytics engine.
4. **Test contractuel** : un test `__tests__/api/webhooks/analytics.test.ts`
   (Bearer KO → 401, page.hit valide → ingest appelé, dédup replay → 200).

## Impact business
Débloque le volet WEB du réconciliateur. Tant que cette route n'existe pas, même
un Analytics parfaitement câblé ne peut rien remonter → le scoring reste
email-only (pas de corrélation cold↔web). Petit effort Hub, prérequis dur du
volet Analytics.

## Dépendances
- Couplé au ticket Analytics `veridian-analytics/todo/2026-06-17-emettre-page-hit-vid-vers-hub-reconciliateur.md`
  (l'émetteur). Les deux doivent partager `ANALYTICS_WEBHOOK_TOKEN` + le format §7.5.1.
- Indépendant du `vid` : `page.hit` avec `contact_email` se score déjà ; sans ni
  l'un ni l'autre, l'event est ingéré pour forensics (non scoré) — comportement attendu.
- Peut être livré AVANT que l'émetteur Analytics soit prêt (la route 200 à vide,
  testée en isolation). Recommandé : livrer la route en premier (cheap-low côté Hub).
