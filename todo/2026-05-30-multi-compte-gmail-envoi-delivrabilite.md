# Multi-compte Gmail d'envoi (délivrabilité) — lever email-match

> **Sévérité** : 🔴 P1 — chantier auth, touche schéma DB + flow OAuth
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-30
> **Demandé par** : Robert
> **Refs** :
> - Contrat mail : `docs/CONTRAT-MAIL.md` §4 + §4.1
> - Ticket Notifuse origine : `../notifuse-veridian/todo/2026-05-25-mail-send-as-user-via-hub-gateway.md`
> - Rebond cross-domain livré : `todo/done/2026-05-30-oauth-gmail-return-bounce-broken.md`

## Décision Robert (2026-05-30)

Un user doit pouvoir connecter **plusieurs comptes Gmail comme expéditeurs**,
**même avec des adresses différentes de son login Veridian**
(`robert@veridian.site` peut ajouter `contact@autreboite.com`,
`perso@gmail.com`...). Objectif : **délivrabilité** — répartir les volumes
d'envoi sur plusieurs boîtes pour préserver la réputation.

→ On **lève la règle `email_mismatch`** du callback OAuth Mail Sender.

## État actuel (ce qui bloque)

Dans `app/api/gmail/connect/callback/route.ts` (~ligne 137) :

```ts
// Sécurité : l'email Google connecté DOIT matcher l'email Hub.
if (tokens.email.toLowerCase() !== user.email.toLowerCase()) {
  // redirect ?status=email_mismatch, PAS d'upsert
}
```

Cette règle empêche tout Gmail tiers d'être lié. C'est elle qu'il faut
remplacer par une isolation propre (pas juste supprimer).

## ⚠️ Pourquoi c'est tier 🔴 et PAS un fix de 5 lignes

La table `Account` est **partagée** entre :
- le **sign-in** Auth.js (provider Google, `allowDangerousEmailAccountLinking`
  ACTIF — cf `auth.ts`, memory `project_oauth_signin_phase1_livre_2026-05-20`)
- le **mail sender** (mêmes lignes Account, champs `mailSendScope` +
  `isDefaultForMail` + `mailSendNeedsReauth`)

`allowDangerousEmailAccountLinking` lie un Account Google à un User **par
email**. Risque à auditer AVANT de livrer :

1. **Un Gmail tiers lié comme expéditeur ne doit JAMAIS devenir un moyen de
   se connecter au compte Veridian.** Analyse préliminaire : un Gmail tiers
   a un email ≠ login → un sign-in avec lui ne se lierait pas au même user
   (il matche/crée un autre user). Le risque est donc inverse et a priori
   géré — MAIS à prouver par test, pas par raisonnement.
2. **Un Account mail-only ne doit pas polluer le flow sign-in** (ex :
   apparaître comme option de connexion, ou être ramassé par un futur
   `linkAccount`).

## Implémentation proposée (à raffiner par l'agent)

### 1. Migration DB — isoler mail-only du sign-in
Ajouter `Account.isMailOnly Boolean @default(false)` (ou réutiliser `type`
= `'mail_sender'` vs `'oauth'`). Un Account créé via le flow
`/api/gmail/connect` pour un Gmail dont l'email ≠ user.email est marqué
`isMailOnly = true`.

`Existing tenants:` colonne nullable/default false → aucun impact sur les
Accounts existants (sign-in + le Gmail self-match déjà lié restent
`isMailOnly = false`, comportement inchangé).

### 2. Callback OAuth — remplacer email_mismatch par tag mail-only
```ts
const isSelfEmail = tokens.email.toLowerCase() === user.email.toLowerCase();
// plus de rejet : on upsert TOUJOURS, en marquant isMailOnly = !isSelfEmail
await prisma.account.upsert({
  ...,
  create: { ..., isMailOnly: !isSelfEmail },
  update: { ... }, // ne pas écraser isMailOnly d'un Account sign-in existant
});
```
⚠️ Sur `update` d'un Account qui existe déjà comme **sign-in** (self-email,
sub déjà présent) : NE PAS le passer en mail-only — garder `isMailOnly`
tel quel.

### 3. Garde-fou sign-in — exclure les Account mail-only
Auditer `auth.ts` callbacks (`signIn`, `jwt`, adapter) : un Account
`isMailOnly = true` ne doit jamais être un chemin de connexion. Vérifier
que l'adapter PrismaAdapter ne ramasse pas ces lignes au `getUserByAccount`.

### 4. Broker mail — déjà multi-compte (rien à changer ?)
`lib/mail/select-account.ts` filtre déjà `provider: 'google'` +
`gmail.send` + `isDefaultForMail`. Vérifier qu'il sélectionne bien les
Account mail-only (il doit — ils ont `gmail.send`). Le contrat
`send-as-user` v1.1 + `mail_account_id` est déjà prêt côté API.

### 5. UI Hub `/dashboard/settings/mail`
Aujourd'hui mono-compte (`accounts.find(...)`). Passer en liste : afficher
tous les Account avec `gmail.send`, badge "défaut", bouton "ajouter un
autre compte" (relance `/api/gmail/connect`). Marquer défaut →
`POST /api/users/{userId}/mail-accounts/{accountId}/default` (existe déjà).

### 6. Tests Nuclear (obligatoires)
- callback : self-email → isMailOnly=false ; email tiers → isMailOnly=true
  + upsert OK (plus de rejet).
- callback : update d'un Account sign-in existant ne le passe pas mail-only.
- **auth (CRITIQUE)** : un Account mail-only NE permet PAS de se connecter
  au compte du user (test d'isolation explicite).
- select-account : un Account mail-only avec gmail.send est sélectionnable.
- UI : liste multi-compte, set défaut.

## Definition of done
- [ ] Migration `isMailOnly` (ou `type='mail_sender'`)
- [ ] Callback : upsert inconditionnel + tag mail-only, email_mismatch retiré
- [ ] Audit + test d'isolation auth (mail-only ≠ chemin de connexion)
- [ ] Broker vérifié multi-compte (probablement déjà OK)
- [ ] UI Hub multi-compte
- [ ] `docs/CONTRAT-MAIL.md` : maj règle email (self vs tiers + isolation)
- [ ] Tests Nuclear verts + E2E groupe H (oauth) avant promo main
- [ ] Marker commit `[risk:high]` (touche auth flow + migration)

## Note cross-app Notifuse
Côté Notifuse, RIEN à changer : il consomme déjà les endpoints multi-compte
(`GET /mail-accounts`, `send-as-user` v1.1 avec `mail_account_id`). Une fois
ce chantier livré, ses comptes tiers remonteront automatiquement dans la
liste `GET /api/users/{userId}/mail-accounts`.
