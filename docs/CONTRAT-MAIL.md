# CONTRAT-MAIL — Veridian Mail Gateway

> **Version** : 1.0 (2026-05-25)
> **Scope** : Gmail uniquement (v1). Microsoft Entra `Mail.Send` prévu v2.
> **Source de vérité** : ce document.
> **Refs** :
> - Vision archi : `todo/2026-05-25-mail-gateway-hub-multi-provider.md`
> - Implémentation Hub : `todo/2026-05-25-gmail-send-implementation-hub.md`
> - OAuth Client 2 : `todo/done/2026-05-25-oauth-google-gmail-client-2-setup-console.md`

---

## 0. Vision

Toutes les apps Veridian (Notifuse, Prospection, CMS, Analytics) doivent
permettre à l'utilisateur d'envoyer des emails depuis **son propre compte
Gmail personnel ou pro**. Le Hub centralise :

- L'OAuth client Google (1 brand verification = N apps consommatrices)
- Le stockage refresh_token + logique de refresh
- L'audit cross-app `hub_app.mail_events`
- L'envoi via Gmail API (`users.messages.send`)

Les apps downstream consomment via une **route HMAC unique** côté Hub :
`POST /api/mail/send-as-user`.

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ App downstream (Notifuse / Prospection / future)            │
│                                                              │
│  UI configurateur "Compte d'envoi" :                        │
│    Bouton → redirect /api/gmail/connect côté Hub            │
│                                                              │
│  Envoi mail :                                                │
│    HMAC POST → <hub>/api/mail/send-as-user                  │
└──────────────────────────│──────────────────────────────────┘
                           │ HMAC <APP>_HUB_API_SECRET
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Hub — Mail Gateway broker                                   │
│                                                              │
│  1. Vérifie HMAC entrant                                    │
│  2. Lookup hub_app.accounts (provider=google,               │
│     mail_send_scope ⊃ gmail.send)                           │
│  3. Refresh access_token si expiré                          │
│     (catch invalid_grant → mail_send_needs_reauth=true)     │
│  4. Construit MIME RFC 2822 (from = user.email)             │
│  5. POST Gmail API users.messages.send                      │
│  6. Insère hub_app.mail_events row (audit + idempotence)    │
│  7. Retour 200 { message_id, provider_used, sent_at }       │
└─────────────────────────────────────────────────────────────┘
```

## 2. Auth HMAC entrante (Pattern A)

Identique au pattern partagé `lib/billing/billing-state-hmac.ts` et
`CONTRAT-HUB.md §6.1`. **Secret réutilisé : `<APP>_HUB_API_SECRET`**
(pas de nouveau secret par scope — rotation 6 mois unique pour tous les
flows Hub↔app).

| Header | Valeur |
|---|---|
| `Content-Type` | `application/json` |
| `x-veridian-app` | `notifuse` \| `prospection` \| `analytics` \| `cms` |
| `X-Veridian-Timestamp` | epoch millisecondes au moment de la requête |
| `X-Veridian-Hub-Signature` | `hex(sha256(<APP>_HUB_API_SECRET, "<timestamp>.<rawBody>"))` |

Anti-replay : drift max 5 minutes (Math.abs(now - ts) > 5min → 401).

Code de référence côté Hub : `lib/mail/send-as-user-hmac.ts`.

## 3. Endpoint `POST /api/mail/send-as-user`

### 3.1 Body (Zod)

```ts
{
  user_id: string,            // hub_app.users.id (cuid Auth.js)
  to: string | string[],      // 1+ destinataires (max 50)
  subject: string,            // 1-998 chars (RFC 2822)
  body_text?: string,         // soit body_text, soit body_html (≥1 requis)
  body_html?: string,
  cc?: string[],              // ≤50
  bcc?: string[],             // ≤50
  reply_to?: string,          // email
  attachments?: [             // ≤10 items
    {
      filename: string,        // 1-255 chars
      content_base64: string,  // base64 standard (pas url-safe)
      mime_type: string        // ex 'application/pdf'
    }
  ],
  provider?: 'google' | 'microsoft' | 'auto',  // v1: google|auto résolu Gmail
  idempotency_key: string,    // UUID v4 obligatoire
  contract_version: '1.0'
}
```

### 3.2 Réponses

| Code | Body | Cas |
|---|---|---|
| 200 | `{ message_id, provider_used: 'google', sent_at: ISO8601, idempotent_replay: boolean }` | Envoi OK ou replay idempotent |
| 400 | `{ error: 'invalid_payload' \| 'invalid_json' \| 'invalid_hmac', ... }` | Body invalide ou headers HMAC manquants |
| 401 | `{ error: 'invalid_hmac', reason }` | Signature ou drift KO |
| 403 | — (réservé v2 si on enforce app_mismatch user↔app) | |
| 404 | `{ error: 'user_not_found' }` | `user_id` inconnu côté Hub |
| 412 | `{ error: 'needs_reauth' }` | refresh_token révoqué — user doit re-consent via `/api/gmail/connect` |
| 422 | `{ error: 'provider_not_linked' }` | User n'a pas connecté son Gmail (mail_send_scope absent) |
| 422 | `{ error: 'provider_not_supported_v1' }` | `provider='microsoft'` demandé en v1 |
| 429 | `{ error: 'rate_limit', retry_after: number }` | Plafond 5/min/(app,user) atteint |
| 503 | `{ error: 'secret_not_configured' \| 'provider_unreachable', ... }` | ENV manquante ou Gmail API down |
| 500 | `{ error: 'internal_error' }` | Bug Hub — observable via logs |

### 3.3 Idempotence

- `idempotency_key` doit être un UUID v4 unique par envoi.
- Si re-POST avec le même key et le 1er envoi avait `status='sent'` →
  retourne 200 avec `idempotent_replay: true` et le `message_id` original.
- Si re-POST avec le même key mais le 1er envoi avait failed/needs_reauth →
  503 (l'app doit générer un nouveau key pour retry).

### 3.4 Rate-limits

- **Pre-HMAC** : 60 req/min/IP (anti-flood broker)
- **Post-HMAC** : 5 req/min/(app + user_id) — strict pour préserver le
  quota Gmail (250 mails/jour standard, 2000 si Workspace). Pour un batch
  outreach Prospection, l'app downstream doit étaler dans le temps OU
  implémenter son propre throttling worker.

### 3.5 Limites Gmail à connaître

| Limite | Standard Gmail | Workspace |
|---|---|---|
| Mails envoyés / jour / user | 250 | 2000 |
| Destinataires / mail | 100 | 100 |
| Taille mail (MIME incluant attachments) | 25 MB | 25 MB |
| Rate burst court | ~quelques/sec | idem |

Au-delà : Gmail répond 429 et peut bloquer le compte 24h-48h. Le broker
Hub ne tente PAS de gérer ce cas (relai direct au caller via 503).

## 4. Flow OAuth utilisateur

L'app downstream redirige l'user vers la page Hub
`GET <hub>/dashboard/settings/mail?return=<url>&provider=google` (UI Hub
qui démarre ensuite `GET <hub>/api/gmail/connect?return=<url>`). Le
paramètre `return` permet de rebondir vers l'UI de l'app après consent.
Flow :

1. Session Auth.js Hub obligatoire (sinon redirect `/login`)
2. State CSRF généré + stocké en cookie signé HttpOnly (TTL 10 min)
3. Redirect Google consent screen avec :
   - `scope=openid email profile https://www.googleapis.com/auth/gmail.send`
   - `access_type=offline` (refresh_token persistant)
   - `prompt=consent` (force re-consent pour récupérer refresh_token)
4. User accepte → callback `/api/gmail/connect/callback?code=<code>&state=<state>`
5. Hub vérifie state cookie, échange code → tokens via Client OAuth #2
6. Vérifie email Google = email Hub (sinon `?status=email_mismatch`)
7. Upsert `Account` Prisma avec `mailSendScope` contenant `gmail.send`
8. Redirect vers `/dashboard/settings/mail?status=connected` (flow Hub
   interne) **ou** rebond vers l'URL `return` avec `?mail_status=<status>`
   (flow app downstream).

### 4.1 Rebond cross-domain `return` (apps downstream)

Une app downstream tourne sur **un autre domaine** que le Hub. Son `return`
est donc une **URL absolue** (`https://notifuse.app.veridian.site/...`),
pas un path relatif. Le Hub l'accepte uniquement si :

- le scheme est **HTTPS**, ET
- le **host** ∈ allowlist `ALLOWED_RETURN_HOSTS`
  (`lib/mail/oauth-cookies.ts` → `validateReturnUrl`). Hosts autorisés :
  `notifuse|prospection|analytics.app.veridian.site`, `cms.veridian.site`,
  et leurs équivalents `*.staging.veridian.site`.

Tout host hors allowlist ou scheme non-HTTPS → le `return` est ignoré
(anti open-redirect / phishing) et le flow retombe sur le fallback Hub
`/dashboard/settings/mail`. La validation est appliquée **3 fois** (pose
du cookie dans `connect`, href de la page `settings/mail`, et au redirect
dans `callback` — défense en profondeur, un cookie altéré ne peut pas
rediriger hors allowlist).

**Contrat de retour côté app downstream** : après rebond, lire le query
param `?mail_status=` qui vaut `connected` | `denied` | `invalid_state` |
`oauth_failed` | `email_mismatch`. (Côté flow Hub interne, le param
s'appelle `status` et non `mail_status` — distinction volontaire.)

**Exemple Notifuse** (cf `console/.../veridian_mail_account_settings.tsx`) :
```
https://app.veridian.site/dashboard/settings/mail
  ?return=https://notifuse.app.veridian.site/console/workspace/<id>/settings/mail-account
  &add=1&provider=google
```
→ rebond final :
```
https://notifuse.app.veridian.site/console/workspace/<id>/settings/mail-account?mail_status=connected
```

Note : en v1, l'user verra le warning Google **"Google hasn't verified this app"**
au consent. Acceptable beta privée (100 slots dispo). Brand verification
Google Trust & Safety à demander avant ouverture publique large.

## 5. Sécurité

- **HMAC strict** : pre-verify rate-limit IP + verify HMAC + post-verify
  rate-limit (app, user_id). Aucun bypass possible.
- **CSRF OAuth** : state cookie HttpOnly + SameSite=Lax, vérifié au callback.
- **Email matching** : l'email Google connecté DOIT matcher l'email Hub.
  Sinon le callback redirige sans persister (prévient l'attaque "user
  clique connecter mais accepte avec un autre compte Google par erreur").
- **PII** : `recipient`, `subject` peuvent contenir des données personnelles.
  FK cascade `mail_events.user_id → users.id` garantit la purge en cas de
  suppression user. Rétention longue acceptable pour audit, purge ≥6 mois
  via cron P3+.
- **Tokens** : `refresh_token` jamais loggué en clair. Stocké en DB sans
  encryption au repos (politique cohérente avec les tokens Auth.js
  existants — chiffrer toute la colonne nécessiterait migration cross-app).
- **Scope sensitive** : gmail.send n'est PAS un scope restricted Google
  (pas besoin de Security Assessment $$$$). Brand verification simple
  suffit pour publication.

## 6. Tables DB

### 6.1 `hub_app.mail_events`

Append-only, FK cascade vers users. Indexes :
- PK `id` (UUID)
- UNIQUE `idempotency_key` (anti double-envoi)
- `(user_id, sent_at DESC)` — timeline user
- `(app_source, sent_at DESC)` — dashboard cross-app

### 6.2 Colonnes ajoutées à `hub_app.accounts`

- `mail_send_needs_reauth BOOLEAN DEFAULT false` — flag levé sur invalid_grant
- `mail_send_scope TEXT` — CSV des scopes effectifs (contient `gmail.send` si autorisé)

Migration : `prisma/migrations/20260525120000_add_mail_events_and_account_mail_send_fields/`.

## 7. Exemple appel app downstream

```ts
import { createHmac, randomUUID } from 'node:crypto';

const secret = process.env.NOTIFUSE_HUB_API_SECRET!;
const hubUrl = process.env.HUB_URL ?? 'https://app.veridian.site';

const body = JSON.stringify({
  user_id: 'cuid_abc123',
  to: 'destinataire@example.com',
  subject: 'Confirmation commande',
  body_text: 'Bonjour, ...',
  body_html: '<p>Bonjour, ...</p>',
  appSource: 'notifuse',
  idempotency_key: randomUUID(),
  contract_version: '1.0',
});

const timestamp = String(Date.now());
const signature = createHmac('sha256', secret)
  .update(`${timestamp}.${body}`)
  .digest('hex');

const res = await fetch(`${hubUrl}/api/mail/send-as-user`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-veridian-app': 'notifuse',
    'X-Veridian-Timestamp': timestamp,
    'X-Veridian-Hub-Signature': signature,
  },
  body,
});

const json = await res.json();
if (!res.ok) {
  if (res.status === 412) {
    // needs_reauth — l'user doit re-consent côté Hub. UI Notifuse doit
    // afficher un bandeau "Reconnecter Gmail" → /api/gmail/connect côté Hub.
  } else if (res.status === 422) {
    // provider_not_linked — l'user n'a pas encore connecté Gmail.
  }
  throw new Error(`Mail Gateway failed: ${json.error}`);
}
```

## 8. Plan v2 — Microsoft Entra `Mail.Send`

- Ajout scope `https://graph.microsoft.com/Mail.Send` au consent screen
  Microsoft Entra (App Registration "Veridian Hub Sign-in" — claims email
  déjà câblés cf `reference_microsoft_entra_oauth.md`).
- Nouveau module `lib/mail/send-microsoft.ts` (Graph API `/me/sendMail`).
- Le param `provider: 'microsoft'` est résolu vers le nouveau path.
- `provider: 'auto'` choisit Gmail si linké, sinon Microsoft, sinon 422.

Aucun changement breaking côté contrat HMAC — bump version vers `1.1`
quand v2 ship, en gardant `1.0` accepté pour backward compat.

## 9. Plan v3 — Premier consommateur app

- Choix : Notifuse ou Prospection
- L'app stocke localement le choix utilisateur (préférence non-critique).
- L'app implémente `services/mail-gateway-client.ts` qui wrap l'appel HMAC.
- L'app refactor ses envois pour router via cette lib si Gmail connecté,
  sinon fallback SMTP générique (Notifuse) ou erreur claire (Prospection).

Tickets côté apps :
- `notifuse-veridian/todo/2026-05-25-mail-send-as-user-via-hub-gateway.md`
- `veridian-prospection/todo/2026-05-25-mail-send-as-user-via-hub-gateway.md`
