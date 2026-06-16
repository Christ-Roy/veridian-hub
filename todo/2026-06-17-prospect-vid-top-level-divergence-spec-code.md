# [HUB] 🐛 P2 — Divergence spec/code : le `vid` au TOP-LEVEL du payload (spec §7.5.1) est ignoré par le code, qui ne lit que `data.vid`

> **Sévérité** : 🟢 P2 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Le trou (prouvé)

Le schéma d'event que TOUTE app émettrice doit suivre (`docs/CONTRAT-HUB.md §7.5.1`, ligne ~2572) place `vid` et `contact_email` **au top-level** du payload JSON :

```json
{
  "event": "email.clicked",
  "app": "notifuse",
  "tenant_id": "ws_acme",
  "vid": "vid_abc123",            ← TOP-LEVEL dans la spec
  "contact_email": "prospect@acme.com",  ← TOP-LEVEL dans la spec
  "occurred_at": "...",
  "idempotency_key": "...",
  "data": { "link_url": "...", "message_id": "..." },
  "contract_version": "1.6"
}
```

Or côté code v1.4 Bearer :

- `lib/webhooks/receiver.ts:31-44` — `V14WebhookPayload` n'a **pas de champ `vid` ni `contact_email`** au top-level. Seuls `event`, `tenant_id`, `data`, `idempotency_key`, `occurred_at`, `contract_version` sont typés.
- `lib/webhooks/notifuse-handlers.ts:36-45` — `behavioralFields(data)` lit **uniquement `data.contact_email` et `data.vid`** (sous-objet `data`), jamais `payload.vid` / `payload.contact_email` top-level.

→ Un émetteur **conforme à la spec §7.5.1** (vid/contact_email au top-level) verra son `vid` et son `contact_email` **silencieusement perdus** par le Hub (`undefined`), donc l'event sera ingéré mais NON joint à un prospect (non scoré).

## Confirmation : le code et la spec ne sont pas d'accord avec eux-mêmes

- La voie LEGACY HMAC (`app/api/webhooks/notifuse/route.ts:329-331`) lit aussi `data.contact_email` / `data.vid` (sous `data`) — cohérent avec le code v1.4, mais **incohérent avec le tableau spec top-level**.
- Le test `__tests__/lib/webhooks/notifuse-handlers.test.ts:189` envoie `data: { contact_email, vid }` (sous `data`) → le test verrouille le comportement `data.*`, donc il PASSE tout en étant en désaccord avec le schéma top-level publié dans le contrat.

Autrement dit : la spec publiée (§7.5.1) ment sur le format réellement accepté. C'est un piège direct pour le prochain émetteur (Analytics `page.hit`), qui lira le contrat, mettra `vid` au top-level, et perdra silencieusement la jointure.

## Fix attendu (choisir UNE source de vérité, voie propre)

Option A (recommandé — aligner le code sur la spec, qui est le contrat public) :
- Ajouter `vid?: string` et `contact_email?: string` au top-level de `V14WebhookPayload` (receiver.ts).
- Dans `behavioralFields` / les handlers, lire `payload.vid ?? data.vid` et `payload.contact_email ?? data.contact_email` (top-level prioritaire, `data.*` en fallback pour la voie legacy/tolérance).

Option B (aligner la spec sur le code) :
- Corriger §7.5.1 + l'exemple JSON pour mettre `vid`/`contact_email` SOUS `data`. Plus risqué : ça contredit l'intention "vid = champ de jointure de premier ordre" et casse l'uniformité avec les autres champs top-level (`tenant_id`, `occurred_at`).

→ A est la voie propre : le `vid` est conceptuellement une clé de jointure de premier ordre (étage 2), il a sa place au top-level, pas noyé dans `data`.

## Sévérité

🟢 P2 mais **à fixer AVANT de brancher Analytics** (le premier émetteur v1.4 Bearer "neuf" qui suivra la spec à la lettre). Latent aujourd'hui car aucun émetteur conforme spec n'est branché. Note : ce ticket est dans MON périmètre (robustesse interne = conformité du code à son propre contrat) ; la coordination de l'émission côté Notifuse/Analytics relève de l'axe cohérence cross-app.
