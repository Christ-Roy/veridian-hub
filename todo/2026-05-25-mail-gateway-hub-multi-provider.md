# [HUB] Mail Gateway centralisé — envoi au nom de l'user multi-provider (Gmail v1, MS v2)

> **Type** : Architecture cross-app — vision long terme
> **Sévérité** : 🔴 P1 — toutes les apps Veridian convergent vers ce broker
> **Owner** : agent Hub (broker) + agents apps (consommateurs)
> **Créé** : 2026-05-25 par team-lead Hub
> **Demandeur** : Robert
> **Refs** :
> - Ticket v1 : `2026-05-25-oauth-google-gmail-send-test-users.md` (extension scope Gmail Hub)
> - Pattern existant : CONTRAT-BILLING §8.4 (Stripe centralisé Hub via HMAC)
> - Pattern OAuth bounce : `CONTRAT-HUB.md §6bis.8` (Couche 4)

---

## 0. Vision arbitrée Robert (2026-05-25)

**Toutes les apps Veridian** (Notifuse, Prospection, futures) doivent
permettre à l'utilisateur d'**envoyer des emails depuis SON propre compte
mail personnel/pro** (Gmail, Microsoft, IMAP custom plus tard).

**Pas** de "Veridian sender générique" — c'est l'user qui envoie, jamais
Veridian au nom de Veridian. Conséquence : la réputation de délivrabilité
est celle de l'user, jamais celle de Veridian.

Use cases concrets :
- Notifuse : transactionnels envoyés depuis le Gmail de l'admin du workspace
- Prospection : campagnes outreach envoyées depuis le Gmail du commercial
- Toute app future : même pattern

## 1. Pourquoi centraliser au Hub

Exactement le même argumentaire que Stripe (CONTRAT-BILLING §8.4) :

1. **1 client OAuth Google = brand verification 1 fois** pour TOUTES les
   apps Veridian. Sinon 1 verif par app = N paperasse Google × scopes
   restricted (~6-8 semaines / app)
2. **1 client OAuth Microsoft = idem** (publisher verification 1 fois)
3. **Refresh token logic 1 fois** (refresh expire 7j en mode Testing,
   forever en Production verified — il faut le tracker, alerter
   l'user quand révoqué, etc.)
4. **Audit cross-app centralisé** : `hub_app.mail_events` table unique
   = "tous les mails envoyés par n'importe quelle app Veridian"
5. **Rate-limits provider centralisés** : Gmail = 250 mails/jour/user en
   standard, 2000 si Workspace. Si 2 apps consomment le quota du même
   user sans coordination = ban du user.
6. **Provider switch / ajout** : ajouter Microsoft en v2 = 1 codebase
   à toucher (Hub), pas N apps.
7. **Cohérent avec l'archi existante** : Stripe est centralisé Hub. OAuth
   sign-in est centralisé Hub (Couche 4 bounce). Mail = même logique.

## 2. Architecture cible

```
┌─────────────────────────────────────────────────────────────┐
│ App downstream (Notifuse / Prospection / future)            │
│                                                              │
│  User dans l'app configure "Mon compte d'envoi" :           │
│    [ Gmail ] [ Microsoft ] [ IMAP (v3) ]                    │
│                                                              │
│  App veut envoyer un mail :                                 │
│    HMAC POST → <hub>/api/mail/send-as-user                  │
│    Body: { user_id, to, subject, body, html?,               │
│            provider?: 'auto'|'google'|'microsoft' }         │
└──────────────────────────│──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Hub — Mail Gateway broker                                   │
│                                                              │
│  1. Vérifie HMAC entrant (réutilise <APP>_HUB_API_SECRET)   │
│  2. Lookup hub_app.Account du user_id                       │
│     → Account.provider IN ('google','microsoft')            │
│     → Si plusieurs providers liés : prend celui spécifié    │
│       par 'provider' param, sinon 'auto' = premier dispo    │
│  3. Refresh access_token si expiré (via OAuth2Client +      │
│     refresh_token persisté)                                 │
│  4. Si refresh_token révoqué (invalid_grant) :              │
│     - Marque Account.mail_send_needs_reauth = true          │
│     - Log [CRITICAL] + retour 412 needs_reauth à l'app      │
│  5. Sinon : appel Gmail API ou MS Graph API                 │
│     - Construit MIME message avec from = user's email       │
│     - users.messages.send (Gmail) ou /me/sendMail (Graph)   │
│  6. Persiste dans hub_app.mail_events :                     │
│     (id, user_id, app_source, provider, to, subject,        │
│      sent_at, provider_message_id, status)                  │
│  7. Retour 200 : { message_id, provider_used, sent_at }     │
└─────────────────────────────────────────────────────────────┘
```

## 3. Plan de déploiement progressif

### v1 (semaine en cours) — Gmail uniquement, beta privée test users

- Hub : extension scope OAuth Google `gmail.send` (ticket
  `2026-05-25-oauth-google-gmail-send-test-users.md`)
- Hub : route `POST /api/mail/send-as-user` (mais v1 = Gmail-only, le
  param `provider` doit être `google` ou `auto` → résolu Gmail)
- Hub : table `hub_app.mail_events` + `Account.mail_send_needs_reauth`
- Hub : lib `lib/mail/send-gmail.ts` + refresh logic
- Pas de consommateur app yet — juste route exposée + UI test dans
  `/dashboard/settings/mail` pour valider bout-en-bout côté Hub seul
- Robert : clics Cloud Console (scope + test users)

### v2 — Microsoft Entra `Mail.Send`

- Hub : extension scope OAuth Microsoft Entra `Mail.Send`
- Hub : lib `lib/mail/send-microsoft.ts` (Graph API)
- Hub : param `provider: 'microsoft'` supporté dans la route
- Robert : action Azure portal pour ajouter le scope + (déjà couvert
  par ticket `2026-05-21-microsoft-publisher-verification-email-claims.md`
  qui a déjà posé les optional claims pour les apps multi-tenants)

### v3 — Premier consommateur app

- Choix : Prospection (campagnes outreach) OU Notifuse (transactionnels)
- L'app consommatrice :
  - Stocke localement `<app>.users.mail_provider_choice` (gmail|microsoft|none)
  - UI configurateur "Mon compte d'envoi" qui display l'état Account côté Hub
  - Endpoint app `POST /api/mail/send` qui HMAC vers Hub Mail Gateway
- Pas de duplication code OAuth, pas de duplication refresh logic

### v4 — IMAP custom (plus tard, ouverture commerciale)

- Hub : support IMAP/SMTP générique avec credentials encrypted (KMS ?)
- Use case : entreprises qui veulent envoyer depuis leur serveur mail
  on-premises (rare mais demande potentielle B2B)

### v5 — Brand verification + publishing

- Quand suffisamment de users beta validés + paperasse prête
- 1 brand verification Google = vaut pour TOUTES les apps consommatrices
- 1 publisher verification Microsoft = idem
- Plus de limite test users, plus de warning UI

## 4. Frontière vs apps (équivalent CONTRAT-BILLING §8.4 pour mail)

| Couche | Owner | Justification |
|---|---|---|
| UI "Choisis ton compte d'envoi" | App downstream | UX native, l'app sait dans quel contexte le mail s'envoie |
| Stockage `mail_provider_choice` | App downstream | Préférence locale, pas business critical |
| **OAuth Google/Microsoft client + scopes** | **Hub** | 1 verif = N apps |
| **refresh_token stockage + refresh** | **Hub** | 1 codebase, 1 garde-fou révocation |
| **Envoi via Gmail API / Graph API** | **Hub** | Pareil que Stripe centralisé |
| **mail_events audit** | **Hub** | Vision cross-app du sent volume / bounces / rate-limit |
| Génération contenu mail (template, render) | App downstream | Spécifique à l'app (template transactionnel vs commercial) |

## 5. Sécurité

- **HMAC entrant strict** (`<APP>_HUB_API_SECRET`)
- **`user_id` body doit matcher** un user existant côté Hub (cf ownership check)
- **Rate-limit** par `user_id` ET par `app_source` (anti spam cross-app)
- **mail_events PII** : `to` peut être PII, RGPD à considérer (retention X jours ?)
- **NEVER log refresh_token / access_token** en clair (déjà règle générale)

## 6. Spec contrat HMAC `POST /api/mail/send-as-user`

```
Path : /api/mail/send-as-user
Auth : HMAC Pattern A entrant
Body Zod :
{
  user_id: string (cuid, le hub_app.users.id),
  to: string (email valide) OR array de strings,
  subject: string (max 998 chars RFC 2822),
  body_text: string (optionnel si body_html),
  body_html: string (optionnel si body_text),
  provider: 'google' | 'microsoft' | 'auto' (default 'auto'),
  reply_to?: string (email),
  cc?: string[],
  bcc?: string[],
  attachments?: [{ filename, content_base64, mime_type }],
  idempotency_key: string (uuid v4, anti-double-envoi),
  contract_version: '1.0'
}

Réponses :
  200 OK : { message_id, provider_used, sent_at, idempotent_replay?: bool }
  400 invalid_payload
  401 invalid_hmac
  404 user_not_found (user_id inconnu côté Hub)
  412 needs_reauth (refresh_token révoqué — l'user doit re-consent)
  422 provider_not_linked (user n'a pas l'Account du provider demandé)
  429 rate_limit (user OU app dépasse le quota)
  503 provider_unreachable (Gmail API / Graph API down)
```

## 7. Definition of done (v1 Gmail-only)

- [ ] Ticket scope `gmail.send` exécuté (Phase 1 manuelle Robert + Phase 2 code Hub)
- [ ] Table `hub_app.mail_events` + migration Prisma
- [ ] Champ `Account.mail_send_needs_reauth` + migration
- [ ] Lib `lib/mail/send-gmail.ts` avec refresh logic
- [ ] Route `POST /api/mail/send-as-user` HMAC entrant
- [ ] UI test dans `/dashboard/settings/mail` (panel "Envoie un mail de test")
- [ ] Tests Nuclear lib + route (10+ cas chacun)
- [ ] Doc `docs/CONTRAT-MAIL.md` v1.0 publiée
- [ ] Push staging + main
- [ ] Smoke test bout-en-bout réel avec test user

## 8. Risques

- **Sessions invalidées au déploiement** : extension scope = re-consent
  obligatoire pour TOUS les users existants. Banner UI courte note avant
  signin pour prévenir.
- **Gmail rate-limit 250/jour/user** (standard) : si on shippe rapidement
  les consommateurs, on peut hit ce mur. Monitoring strict + escalade
  proactive à 200/jour.
- **Refresh token 7j en Testing** : pendant la beta privée, les users
  doivent se reconnecter chaque semaine. Documenter clairement.

## 9. Coordination

Ticket parent qui chapeaute :
- `2026-05-25-oauth-google-gmail-send-test-users.md` (v1 scope Gmail)
- futur `2026-05-25-microsoft-mail-send-scope-v2.md` (v2 Microsoft, à
  créer après v1 validée)
- futurs tickets apps consommatrices (v3) :
  `veridian-notifuse/todo/...mail-send-as-user-via-hub.md` +
  `veridian-prospection/todo/...mail-send-as-user-via-hub.md`
