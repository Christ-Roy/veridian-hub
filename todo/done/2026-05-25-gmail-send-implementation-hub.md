# [HUB] Gmail Send — implémentation code Hub (lib + route HMAC + OAuth flow)

> **Type** : Feature backend — Mail Gateway v1 Gmail-only
> **Sévérité** : 🟡 P1 — débloque envoi mail au nom de l'user pour toutes les apps
> **Owner** : sub-agent Opus dédié (à spawner en début de session prochaine)
> **Créé** : 2026-05-25
> **Refs** :
> - Vision archi : `todo/2026-05-25-mail-gateway-hub-multi-provider.md`
> - Console créé : `todo/done/2026-05-25-oauth-google-gmail-client-2-setup-console.md`
> - Credentials : `~/credentials/.all-creds.env` (`GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET`)

---

## 0. Pré-requis (déjà OK)

- ✅ OAuth Client 2 `Veridian Mail Sender` créé console Google Cloud (mode Production, 100 slots dispo)
- ✅ Scope `gmail.send` ajouté au consent screen `veridian-preprod`
- ✅ Credentials dans `~/credentials/.all-creds.env`
- ✅ Routes `/api/gmail/connect/callback` autorisées (prod + staging + localhost)

## 1. Livrables

### 1.1 ENV propagation
- Ajouter `GOOGLE_MAIL_CLIENT_ID` + `GOOGLE_MAIL_CLIENT_SECRET` dans :
  - `compose/base.yml` (référence)
  - `compose/staging.yml` (avec `${GOOGLE_MAIL_CLIENT_*}` du `.env` staging)
  - `compose/prod.yml` (idem prod)
  - `.env.example` (template)
- Workflow CI `.github/workflows/hub-staging.yml` : injecter les 2 secrets dans `/opt/staging/hub/.env`
- Côté GH secrets repo : `STAGING_GOOGLE_MAIL_CLIENT_ID` + `STAGING_GOOGLE_MAIL_CLIENT_SECRET` + `PROD_GOOGLE_MAIL_CLIENT_ID` + `PROD_GOOGLE_MAIL_CLIENT_SECRET`

### 1.2 Migration DB
- Nouvelle table `hub_app.mail_events` (audit cross-app envois) :
  ```sql
  CREATE TABLE hub_app.mail_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id),
    app_source TEXT NOT NULL,  -- 'notifuse' | 'prospection' | 'cms' | 'analytics'
    provider TEXT NOT NULL,    -- 'google' | 'microsoft' (v2)
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    provider_message_id TEXT,
    status TEXT NOT NULL,      -- 'sent' | 'failed' | 'needs_reauth'
    error_message TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    sent_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX idx_mail_events_user ON hub_app.mail_events(user_id, sent_at DESC);
  CREATE INDEX idx_mail_events_app ON hub_app.mail_events(app_source, sent_at DESC);
  ```
- Ajout champ `Account.mail_send_needs_reauth BOOLEAN DEFAULT false` (Prisma)
- Migration avec `Existing tenants:` dans le body commit (rule CLAUDE.md)

### 1.3 Lib `lib/mail/gmail-oauth.ts`
Wrapper OAuth2Client séparé pour le Client 2 :
```ts
import { OAuth2Client } from 'google-auth-library';

export function getMailOAuthClient(redirectUri: string): OAuth2Client {
  return new OAuth2Client({
    clientId: process.env.GOOGLE_MAIL_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_MAIL_CLIENT_SECRET!,
    redirectUri,
  });
}

export function getMailAuthUrl(state: string, redirectUri: string): string {
  // scope: openid email profile + gmail.send
  // access_type: 'offline' (pour récup refresh_token)
  // prompt: 'consent' (forcer re-consent si déjà autorisé pour scope basic)
}
```

### 1.4 Routes OAuth flow
- `GET /api/gmail/connect` (Server Component qui redirect vers Google consent URL)
- `GET /api/gmail/connect/callback` (reçoit code, échange contre tokens, stocke dans `Account` Prisma avec scope `gmail.send`)
- `POST /api/gmail/disconnect` (revoke + clear refresh_token DB)

### 1.5 Lib `lib/mail/send-gmail.ts`
```ts
export async function sendGmailAsUser(userId: string, params: {
  to: string | string[];
  subject: string;
  body_text?: string;
  body_html?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  attachments?: Attachment[];
}): Promise<{ messageId: string; sentAt: Date }> {
  // 1. Lookup Account du user où provider='google' AND scope contains 'gmail.send'
  // 2. Refresh access_token si expired (via OAuth2Client + refresh_token)
  // 3. Catch invalid_grant → marquer mail_send_needs_reauth=true + throw NeedsReauth
  // 4. Construire MIME message (RFC 2822) with from = user's email
  // 5. gmail.users.messages.send({ userId: 'me', requestBody: { raw: base64url(mime) } })
  // 6. Persister hub_app.mail_events row
  // 7. Return { messageId, sentAt }
}
```

### 1.6 Route HMAC `POST /api/mail/send-as-user`
Pour les apps downstream (Notifuse, Prospection, etc.) :
- Auth HMAC Pattern A entrant (réutilise `<APP>_HUB_API_SECRET`)
- Body Zod strict (cf `mail-gateway-hub-multi-provider.md` §6)
- Idempotency check sur `mail_events.idempotency_key`
- Appelle `sendGmailAsUser(user_id, ...)`
- Codes erreur : 401 invalid_hmac, 404 user_not_found, 412 needs_reauth, 422 provider_not_linked, 429 rate_limit

### 1.7 UI test settings
- Section dans `app/dashboard/settings/page.tsx` (ou nouvelle route `/settings/mail`) :
  - Card "Compte d'envoi mail"
  - Si Account Google avec scope gmail.send existe → bouton "Tester l'envoi" + status connexion
  - Sinon → bouton "Connecter mon Gmail" → redirect `/api/gmail/connect`
  - Si `mail_send_needs_reauth=true` → warning rouge "Reconnexion requise"

### 1.8 Tests Nuclear

- `__tests__/lib/mail/gmail-oauth.test.ts` (scopes, URL gen)
- `__tests__/lib/mail/send-gmail.test.ts` (mock googleapis : refresh OK, invalid_grant→NeedsReauth, MIME OK, etc.)
- `__tests__/api/gmail/connect/callback.test.ts` (code→tokens flow)
- `__tests__/api/mail/send-as-user.test.ts` (HMAC, idempotence, error codes)

### 1.9 Doc CONTRAT-MAIL.md v1.0
Nouveau fichier `docs/CONTRAT-MAIL.md` qui spec le contrat HMAC `POST /api/mail/send-as-user` v1 Gmail-only (à étendre v2 Microsoft plus tard).

## 2. Test bout-en-bout réel obligatoire

Avant promo main :
1. Aller sur `/dashboard/settings/mail` en staging
2. Cliquer "Connecter mon Gmail" → consent Google (acceptable warning unverified) → callback OK
3. Vérifier Account row côté Prisma : refresh_token persisté
4. Cliquer "Tester l'envoi" → mail reçu sur la boîte du test user
5. Vérifier `mail_events` row avec status='sent' + provider_message_id

## 3. Definition of done

- [ ] ENV propagées 3 composes + .env.example + workflow CI
- [ ] Migration DB `mail_events` + `Account.mail_send_needs_reauth`
- [ ] Lib `gmail-oauth.ts` + `send-gmail.ts`
- [ ] 3 routes (`connect`, `connect/callback`, `disconnect`, `send-as-user`)
- [ ] UI test dans `/dashboard/settings/mail`
- [ ] Tests Nuclear pour les 4 fichiers (≥30 tests cumul)
- [ ] Doc `docs/CONTRAT-MAIL.md` v1.0
- [ ] Test bout-en-bout réel OK (mail reçu)
- [ ] Push staging + main
- [ ] Spec E2E `e2e/staging-full/22-gmail-send-flow.spec.ts` (mock OAuth Google côté tests)

## 4. Marker

`[risk:medium]` (touche auth + nouvelle table DB) — promote autonome après E2E vert.

## 5. Estimation

~6h dev (lib + routes + UI + tests + doc).

## 6. Pré-requis ENV avant agent
Vérifier que ces 2 entrées existent dans GH secrets `Christ-Roy/veridian-hub` avant l'agent (sinon il les pose) :
- `STAGING_GOOGLE_MAIL_CLIENT_ID`
- `STAGING_GOOGLE_MAIL_CLIENT_SECRET`
- `PROD_GOOGLE_MAIL_CLIENT_ID`
- `PROD_GOOGLE_MAIL_CLIENT_SECRET`
