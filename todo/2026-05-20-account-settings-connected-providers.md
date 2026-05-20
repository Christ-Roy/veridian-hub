# [HUB] Page Settings → Account → Connected providers

> **Type** : Feature UI
> **Sévérité** : 🟡 P2 (bonne UX, attendu sur tout SaaS standard)
> **Owner** : agent Hub
> **Créé** : 2026-05-20

## Contexte

Avec OAuth Sign-in livré 2026-05-20, un user peut avoir N rows dans
`hub_app.accounts` (Credentials + Google + Microsoft) — mais aucune UI ne lui
permet aujourd'hui de :
- Voir ses providers connectés
- Connecter un nouveau provider depuis le dashboard (sans passer par le login)
- Déconnecter un provider (= supprimer la row `accounts`)
- Définir son provider primary

C'est le standard absolu sur tout SaaS moderne (GitHub Settings → Account
Security, Stripe Dashboard → Profile, Vercel → Settings → Login Connections).

## À livrer

### Page `/dashboard/settings/account`

UI table :
| Provider | Email lié | Connecté depuis | Actions |
|---|---|---|---|
| 🔵 Google | brunon5robert@gmail.com | il y a 2 jours | [Disconnect] |
| 🔴 Microsoft | robert.brunon@veridian.site | il y a 5 minutes | [Disconnect] |
| 🔐 Email + Password | brunon5robert@gmail.com | il y a 8 mois | [Change password] |

Boutons "Connect Google" / "Connect Microsoft" si pas déjà connecté.

### Endpoints

- `GET /api/account/providers` — liste des accounts du user loggué
- `POST /api/account/providers/[provider]/connect` — redirige vers OAuth flow avec callback custom
- `DELETE /api/account/providers/[provider]` — supprime la row `accounts`
  - Refuse si c'est le **dernier moyen de login** du user (sinon il se locke out)
  - Côté Google : appelle aussi `POST oauth2.googleapis.com/revoke` pour invalider le refresh token

### Garde-fous

- Au moins 1 provider doit rester connecté à tout moment
- Si user n'a que Credentials, autoriser disconnect Google même si dernier OAuth → mais bloquer si user n'a aucun password set
- Audit log : chaque connect/disconnect → row `hub_app.audit_log` (à créer aussi)

### Tests

- RTL : table renders correctement avec 0/1/2/3 providers
- E2E : flow disconnect Google complet
- Anti-lockout : disconnect dernier provider → erreur claire

## Effort estimé

- 2-3j : page UI + 3 endpoints + tests

## Dépendances

- Aucune — peut être livré indépendamment du flow invitation

## Référence

- Pattern Stripe : https://dashboard.stripe.com/settings/user
- Pattern GitHub : https://github.com/settings/security
- Phase 1.G du ticket OAuth principal (différé) : `todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md`
