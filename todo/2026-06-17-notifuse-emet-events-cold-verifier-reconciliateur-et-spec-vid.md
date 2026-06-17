# [HUB] Notifuse émet désormais les events cold → vérifier le réconciliateur + spécifier le format `vid`

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 par agent Notifuse (team-orchestration vague 2 cold)
> **Refs** : `notifuse-veridian` commit `7381ace5` (émission events) ; ticket Hub réconciliateur `2026-06-15-reconciliateur-*`

## Contexte

Le réconciliateur de scoring prospect côté Hub (`ingestProspectEvent` /
`app/api/webhooks/notifuse/route.ts:dispatchLegacyEvent`) était livré en prod mais
**orphelin** : Notifuse n'émettait pas les events comportementaux, donc 0 row dans
`prospect_events` / `prospect_scores`.

**C'est corrigé côté Notifuse** (livré staging, SHA `7381ace5`, promo prod imminente) :
Notifuse émet maintenant `email.opened` / `email.clicked` / `email.replied` vers
`HUB_WEBHOOK_URL` via le `VeridianWebhookEmitter` (voie legacy HMAC, header
`X-Veridian-Notifuse-Signature`, secret `HUB_WEBHOOK_SECRET`, best-effort 3 retries).

Payload émis par Notifuse (contrat vérifié contre `dispatchLegacyEvent`) :
```
{
  event_type: "email.opened" | "email.clicked" | "email.replied",
  event_id:   <idempotency>,
  tenant_id:  <workspaceID = notifuseWorkspaceSlug>,
  data: { contact_email: <normalisé lowercase>, message_id, occurred_at: RFC3339, match_type?: <reply only>, vid?: <null pour l'instant> }
}
```

## Demandes (2)

### 1. Vérifier que le réconciliateur se peuple (dès que Notifuse prod landé)
Une fois la promo prod Notifuse faite (events émis depuis la prod), confirmer que
`prospect_events` et `prospect_scores` se remplissent côté Hub (staging d'abord si
possible, puis prod). Le réconciliateur sort de l'état orphelin. Vérifier la
jointure V1 par `contact_email` (lowercase des deux côtés).

### ~~2. Spécifier le format du `vid`~~ — SANS OBJET (vérifié 2026-06-17)
Le `vid` est NULL par design pour les events attribuables par email (modèle Hub
`analytics-pull.ts`/`types.ts` : vid = seulement pour events WEB anonymes). Les events
cold Notifuse ont tous `contact_email` → jointure V1 directe, pas de vid requis. Rien à
spécifier côté Hub pour le cold. Le webhook Hub ingère déjà open/click/replied
(route.ts:335-352). Reste UNIQUEMENT la demande #1 : vérifier le peuplement réel.
