# [HUB] OAuth Google — activer scope gmail.send en mode Testing (beta privée)

> **Type** : Extension OAuth Google — scope restricted
> **Sévérité** : 🟡 P1 — débloque envoi mail Veridian au nom du user
> **Owner** : Robert (action manuelle Cloud Console) + agent Hub (code)
> **Créé** : 2026-05-25 par team-lead Hub
> **Demandeur** : Robert
> **Refs** :
> - Config OAuth actuelle : `auth.config.ts:32` scope `'openid email profile'`
> - Doc Google : https://developers.google.com/identity/protocols/oauth2/scopes#gmail
> - Doc Testing mode : https://support.google.com/cloud/answer/10311615
> - Memory `project_oauth_signin_phase1_livre_2026-05-20.md`

---

## 0. Objectif

Permettre à Veridian d'**envoyer des mails au nom de l'utilisateur via son
compte Gmail** (use case : campagnes prospection, follow-up depuis sa
boîte perso au lieu d'un sender Veridian générique). En mode **Testing
sans brand verification** pour démarrer la beta privée rapidement.

## 1. Limites Google à connaître (mode Testing avec scope restricted)

| Contrainte | Impact |
|---|---|
| **100 test users max** | Liste à maintenir manuellement dans Cloud Console |
| **Refresh token expire 7 jours** | Chaque user doit re-consent hebdo, sinon `invalid_grant` |
| **Warning "unverified app"** | Visible au consent, lien "Advanced > Continue (unsafe)" — perte UX |
| **Workspace 2FA enforced** | Certaines orgs refusent les scopes restricted via policy admin |
| **Pas d'ouverture commerciale** | Mode Testing = beta privée uniquement, brand verif obligatoire pour prod publique |

Pour ouverture commerciale large : **brand verification Google + Trust & Safety review** (~6-8 semaines, scope restricted = process plus lourd que les scopes basic).

## 2. Actions manuelles Robert (Cloud Console, ~15 min)

### Step 1 — Ajouter le scope dans OAuth Consent Screen
1. `console.cloud.google.com/auth/scopes` (projet `veridian-preprod`)
2. Add or remove scopes → cocher `https://www.googleapis.com/auth/gmail.send`
3. Save (status passe à "Sensitive scopes" required — c'est attendu en Testing)

### Step 2 — Ajouter les test users
1. `console.cloud.google.com/auth/audience` → Test users section
2. Add user → liste les emails à autoriser (max 100)
3. Save

### Step 3 — Confirmer publishing status
- Doit rester en `Testing` (pas Publish App, sinon Google va exiger brand verif immédiate pour `gmail.send`)

### Step 4 — Vérifier
- `curl https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&scope=openid%20email%20profile%20https://www.googleapis.com/auth/gmail.send&...` doit retourner le consent screen avec mention "Send email on your behalf"

## 3. Actions code Hub (agent Hub, ~3-4h)

### Livrable 1 — Extension scope auth.config.ts

Modifier `auth.config.ts:32` :

```ts
authorization: {
  params: {
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent',  // force re-consent pour récup refresh_token
  },
},
```

**Backward compat** : les users existants qui ont déjà consenti `openid email profile` seront re-promptés au prochain login pour ajouter le scope `gmail.send`. Pas de breaking, juste un re-consent.

### Livrable 2 — Stockage refresh_token + access_token

Vérifier que Auth.js v5 stocke bien `refresh_token` + `access_token` + `expires_at` dans la table `Account` (Prisma). Si non, étendre le callback `signIn` ou `jwt` pour les persister.

```ts
// auth.ts callback events.signIn
async signIn({ account }) {
  if (account?.provider === 'google' && account.refresh_token) {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        refresh_token: account.refresh_token,
        access_token: account.access_token,
        expires_at: account.expires_at,
      },
    });
  }
}
```

### Livrable 3 — Lib `lib/gmail/send.ts`

```ts
import { google } from 'googleapis';

export async function sendGmailAsUser(userId: string, params: {
  to: string;
  subject: string;
  body: string;  // text/plain ou text/html
  bcc?: string[];
}): Promise<{ messageId: string }> {
  // 1. Lookup Account Google du user
  // 2. Refresh access_token si expiré (via OAuth2Client + refresh_token)
  // 3. Construire MIME message (with from = user's email)
  // 4. Appeler gmail.users.messages.send avec userId='me'
  // 5. Retourner messageId
  // 6. Si erreur 'invalid_grant' (refresh token révoqué) → marquer Account
  //    en `gmail_send_needs_reauth = true` + log + return clean error
}
```

### Livrable 4 — Route API + UI

- `POST /api/gmail/send` (Server Action ou Route) qui appelle la lib
- UI : panel test dans `/dashboard/settings` "Tester l'envoi Gmail" qui envoie un mail à soi-même pour valider le scope

### Livrable 5 — Tests Nuclear

- `__tests__/lib/gmail/send.test.ts` : mock googleapis, couvre refresh token expired, scope manquant, user non-Google
- `__tests__/api/gmail/send.test.ts` : auth user, validation Zod, error handling

## 4. Validation finale

- Push staging
- Test manuel (test user dans la liste) : login Veridian → re-consent → envoie un mail test à toi-même → vérifie réception
- Marker commit `[risk:medium]` (touche auth scope, donc invalidation des sessions existantes)
- Note migration : `Existing tenants:` users existants devront re-consent au prochain login (warning UI courte note avant signin)

## 5. Risques

- **Sessions invalidées** : tout user existant avec session active devra re-consent. Si tu ne veux pas casser les sessions live, déployer en off-hours.
- **Refresh token 7 jours** : si un test user ne se reconnecte pas pendant 7 jours, son refresh token expire → besoin de re-consent. Documenter clairement côté UI.
- **Beta privée stricte** : ne jamais publier l'app tant que les 100 test users sont suffisants. Si on dépasse → brand verif obligatoire.

## 6. Plan de promotion future (hors scope ce ticket)

Quand on veut ouvrir commercialement :

1. Préparer dossier brand verification Google (scopes restricted = process T&S Review)
2. Vidéo démo YouTube du flow consent + use case
3. Privacy policy doit explicitement mentionner `gmail.send` use case + data retention
4. App logo HD + homepage Veridian branded propre (déjà OK)
5. Submit → 6-8 semaines de review
6. Approval → `Publish App` → plus de limite 100 users + plus de warning

## 7. Definition of done

### Phase 1 — Manuelle Robert (15 min)
- [ ] Scope `gmail.send` ajouté dans Cloud Console
- [ ] Test users ajoutés (liste fournie à agent Hub)
- [ ] Status confirmé `Testing` (pas Publish)

### Phase 2 — Code Hub (agent)
- [ ] Scope étendu dans `auth.config.ts`
- [ ] `refresh_token` persisté dans `Account` Prisma
- [ ] Lib `lib/gmail/send.ts` livrée + refresh logic
- [ ] Route `/api/gmail/send` + UI test dans settings
- [ ] Tests Nuclear (lib + route)
- [ ] Push staging
- [ ] Test bout-en-bout réel : login test user → consent → envoie mail à soi-même → réception OK
- [ ] Promote main
