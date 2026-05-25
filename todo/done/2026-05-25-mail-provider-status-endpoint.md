# [HUB] Endpoints Mail Gateway v2 — status + multi-comptes + rate-limit per-recipient

> **Type** : Feature — étendre l'API Hub Mail Gateway pour multi-comptes OAuth + rate limiting
> **Sévérité** : 🟡 P1
> **Owner** : agent Hub
> **Créé** : 2026-05-25 par agent Notifuse (mail-ui-settings, vague 6)
> **Mis à jour** : 2026-05-25 par Robert (multi-comptes + rate limit) puis team-lead Notifuse vague 7
> **Demandeur cross-app** : Notifuse (et futurs Prospection, CMS)
> **Refs cross-app** :
> - Ticket parent Notifuse : `../notifuse-veridian/todo/done/2026-05-25-mail-send-as-user-via-hub-gateway.md`
> - Vision archi Hub : `todo/2026-05-25-mail-gateway-hub-multi-provider.md`
> - Implémentation Hub Mail Gateway v1 livrée staging : `POST /api/mail/send-as-user`

---

## Décision Robert 2026-05-25

> "il faut pouvoir avoir autant de mail 0authed sur les compte et aussi set
> une limite a 1 mail toutes les 20 minutes comme limliste par email"

3 ajouts au Hub Mail Gateway :

1. **Multi-comptes OAuth par user** : un user peut connecter Gmail (perso) + Microsoft (pro) + un autre Gmail → sélectionner lequel envoyer dans Notifuse
2. **Rate limiting per recipient** : 1 mail max / 20 min / email destinataire — protection anti-spam Lemlist-like
3. **Endpoint status** (origine du ticket) : exposer l'état connexion à Notifuse pour UI vague 7

---

## 1. `GET /api/users/{userId}/mail-accounts` (nouveau)

### Auth HMAC Pattern A
```
x-veridian-app: notifuse (ou prospection / cms)
X-Veridian-Timestamp: <epoch_ms>
X-Veridian-Hub-Signature: <hex sha256 hmac sur ${ts}.>  (GET = body vide)
```

### Response 200
```json
{
  "accounts": [
    {
      "id": "acc_clx123abc",
      "provider": "google",
      "email": "robert@gmail.com",
      "name": "Robert Brunon",
      "is_default": true,
      "needs_reauth": false,
      "connected_at": "2026-05-20T10:00:00Z"
    },
    {
      "id": "acc_clx456def",
      "provider": "microsoft",
      "email": "robert@entreprise.com",
      "name": "Robert (work)",
      "is_default": false,
      "needs_reauth": true,
      "connected_at": "2026-05-22T14:00:00Z"
    }
  ]
}
```

### Response 404
User pas trouvé Hub-side : `{ "error": "user_not_found" }`

### Response 200 (vide)
User existe mais aucun compte connecté : `{ "accounts": [] }`

---

## 2. `POST /api/users/{userId}/mail-accounts/{accountId}/default` (nouveau)

Marque un compte comme défaut pour les envois `POST /api/mail/send-as-user` sans `mail_account_id` explicite.

### Auth HMAC Pattern A
Body vide. Canonical = `${ts}.`

### Response 200
```json
{
  "user_id": "u_clx789",
  "account_id": "acc_clx123abc",
  "is_default": true
}
```

---

## 3. `POST /api/mail/send-as-user` étendu (existant + nouveau param)

### Body Zod v1.1 (additif, back-compat v1.0)
```ts
{
  user_id: string,
  to: string | string[],
  subject: string,
  body_text?: string,
  body_html?: string,
  cc?: string[],
  bcc?: string[],
  reply_to?: string,
  attachments?: [...],
  idempotency_key: string,
  contract_version: "1.0" | "1.1",
  // NOUVEAU v1.1 — optionnel, défaut = compte is_default user
  mail_account_id?: string  // si omis → défaut user
}
```

### Réponses étendues v1.1

- 200 : `{ message_id, sent_at, idempotent_replay?, mail_account_id_used }`
- 404 : ajouter discrimination `{ "error": "account_not_found" }` si `mail_account_id` fourni mais inexistant
- **429 NEW** : `{ "error": "rate_limit_recipient", "recipient": "spam@example.com", "retry_after_seconds": 1200 }` quand le rate limit per-recipient déclenche

---

## 4. Rate limiting per recipient (NOUVELLE feature critique)

### Règle
**1 mail maximum / 20 minutes / email destinataire** — appliquée GLOBAL Hub (cross-app, cross-account user).

### Implémentation suggérée
- Table `hub_app.mail_recipient_rate_limit` : `(recipient_email PRIMARY KEY, last_sent_at TIMESTAMP, sender_user_id TEXT, app_caller TEXT)`
- Check at `POST /api/mail/send-as-user` : SELECT WHERE recipient_email = X. Si `last_sent_at > NOW - 20 min` → 429 avec `retry_after_seconds = 1200 - (NOW - last_sent_at)`.
- Si OK → UPSERT + procède à l'envoi Gmail/Microsoft.

### Couverture
- S'applique sur `to` array (chaque destinataire vérifié séparément). Si 1 dans le batch est rate-limited → option (A) skip ce destinataire + 207 multi-status, (B) refuser tout le batch en 429. Reco : **(A)** car broadcasts à 100 destinataires ne doivent pas tomber sur 1 récidiviste.
- NE PAS s'appliquer sur `cc` / `bcc` (audit cross-app décide).
- Override possible via header `X-Veridian-Bypass-Rate-Limit: <admin_token>` pour Robert / tests E2E.

### Audit
- Log table `hub_app.mail_rate_limit_events` chaque trigger 429 : `(timestamp, recipient_email, sender_user_id, app_caller, retry_after_seconds)`
- Endpoint `GET /api/admin/mail-rate-limit/stats` pour monitoring.

---

## 5. Use cases Notifuse vague 7 (consumer)

L'UI `/console/workspace/<id>/settings/mail-account` Notifuse (livrée vague 6) doit évoluer pour :

1. **Fetcher** `GET /api/users/{userId}/mail-accounts` au mount
2. **Afficher liste comptes** : par défaut + détails (provider, email, needs_reauth)
3. **Sélecteur "compte par défaut"** : radio → `POST .../default`
4. **Bouton "Connecter un autre compte"** : redirect Hub avec scope choisi
5. **Bouton "Déconnecter"** par compte (DELETE à spécifier)
6. **Warning needs_reauth** : badge rouge sur le compte concerné + bouton "Reconnecter"

Pour le rate limit : la lib `pkg/hub_mail_gateway` doit map le 429 `rate_limit_recipient` vers un nouveau Reason `recipient_rate_limited` pour que les broadcasts gèrent (skip + log + UI feedback).

---

## DoD

- [ ] `GET /api/users/{userId}/mail-accounts` livré + tests
- [ ] `POST /api/users/{userId}/mail-accounts/{accountId}/default` livré + tests
- [ ] `POST /api/mail/send-as-user` v1.1 accepte `mail_account_id`
- [ ] Rate limit per-recipient implémenté + table + 429 `rate_limit_recipient`
- [ ] Endpoint stats `GET /api/admin/mail-rate-limit/stats`
- [ ] Smoke prod : curl les 3 nouveaux endpoints depuis Notifuse staging avec HMAC valide
- [ ] Notifié agent Notifuse via reply dans ce ticket (date + endpoints URL)

## Référence

- Contrat HMAC : matrice v3 dans `../notifuse-veridian/CLAUDE.md` (commit `03d6ddd9`)
- Auth.js v5 pattern multi-comptes : `Account` table supporte déjà N rows par userId
- Inspiration rate limit per-recipient : Lemlist (max 1 email/contact/jour)

## Réponse E2E discovery — 2026-05-25 (agent Notifuse mega-e2e-vague-67)

Specs MEGA-07 (`tests/e2e-veridian/specs/mega/07-mail-gateway-end-to-end.spec.ts`)
contre `https://hub.staging.veridian.site/api/mail/send-as-user` :

**Subgroup A (v1.0)** : 6/6 verts. Hub valide bien le contrat v1.0 livré.
HMAC, body validation Zod, 404 user_not_found, 401 invalid_hmac, OPTIONS preflight :
toutes les shapes JSON matchent ce que `pkg/hub_mail_gateway/client.go` attend.

**Subgroup B (v1.1)** : 2/2 skippés. Réponse Hub claire :
```json
{"error":"invalid_payload","issues":[{"code":"invalid_value","values":["1.0"],"path":["contract_version"],"message":"Invalid input"}]}
```
→ Zod schema Hub n'autorise QUE `"1.0"` pour `contract_version`. Le champ
`mail_account_id` n'est probablement pas dans le schéma non plus.
**Action attendue côté Hub** : étendre `app/api/mail/send-as-user/route.ts`
Zod schema pour accepter `contract_version: z.enum(['1.0', '1.1'])` +
`mail_account_id: z.string().uuid().optional()`. Quand fait, B1 et B2
passeront automatiquement.

**Subgroup C (rate-limit per-recipient)** : skippé en cascade (le 6×spam
retourne 6×400 invalid_payload sur v1.1 schema avant même d'atteindre la
phase auth/RL). Sera testable une fois v1.1 schema livré.

**Aucun bug détecté côté Notifuse** : la lib `pkg/hub_mail_gateway`
envoie `contract_version: "1.0"` (mode auto sans MailAccountID) et c'est
accepté par Hub. Le fallback est correct. Quand v1.1 sera livré, la lib
basculera automatiquement sur "1.1" si `MailAccountID != ""`.
