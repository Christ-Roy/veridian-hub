# [HUB] Pages login fallback des apps doivent rediriger vers Hub OAuth

> **Type** : UX / cohérence cross-app
> **Sévérité** : 🟡 P2 (cohérence d'expérience marque Veridian)
> **Owner** : agent Hub (pour spec) + agents Notifuse/Prospection/Analytics/CMS (pour impl côté chaque app)
> **Créé** : 2026-05-20

## ⚠️ STATUT 2026-05-23 — spec gravée dans CONTRAT-HUB, à implémenter

**Ce ticket n'est plus une spec à débattre — c'est une implémentation à
livrer.** La spec OAuth cross-app a été formalisée dans le contrat
2026-05-23 :

➡️ **`docs/CONTRAT-HUB.md` §6bis.8 « Couche 4 — Bounce OAuth Hub »**

Le contrat couvre désormais, de façon **agnostique au nom des apps** (toute
future `*.veridian.site` est éligible sans modif Hub) :
- 6bis.8.1 — bouton standardisé côté apps downstream
- 6bis.8.2 — gestion du `?next=` côté Hub + whitelist regex anti
  open-redirect
- 6bis.8.3 — endpoint contractuel `POST /api/sso/issue-magic-link`
  exposé par chaque app (réutilise la logique magic_link couche 3)
- 6bis.8.4 — cas particuliers (user déjà loggué, staging, boucle)
- 6bis.8.5 — tests contractuels obligatoires Hub + apps
- 6bis.8.6 — récap onboarding nouvelle app (zéro modif Hub requise)

Et la §5 liste désormais 9 endpoints obligatoires (le 9e étant
`issue-magic-link`).

**Ce qui est livré** : OAuth Google + Microsoft sur
`app.veridian.site/login` (Auth.js v5, livré 2026-05-20). Login direct OK
en prod.

**Ce qui reste à implémenter (agent Hub)** :
1. Param `?next=<url>` sur `/login` Hub (cf. 6bis.8.2)
2. Cookie temporaire `__Secure-veridian-next` pour persister `next`
   pendant le flow OAuth
3. Après OAuth réussi : extraire app cible du `next`, appeler
   `POST /api/sso/issue-magic-link` en HMAC, redirect 302 vers le magic
   link reçu
4. Gestion erreurs (5xx app, 400 user_not_in_app, next invalide)
5. Tests CI bloquants (cf. 6bis.8.5)

**Ce qui reste à implémenter (chaque app downstream)** :
- Endpoint `POST /api/sso/issue-magic-link` (HMAC §6.1, contrat 6bis.8.3)
- Boutons standardisés sur `/login` (6bis.8.1)
- Tests CI bloquants

**Impact actuel** : 1+ tickets bloqués en attente côté apps :
- `notifuse-veridian/todo/2026-05-20-add-oauth-buttons-login-page.md`
- Prospection / Analytics / CMS : à créer si pas déjà fait.

**Estimation Hub restant** : ~45-60 min (élargi pour couvrir la
gestion cookie + erreurs propres + tests).

---

## Contexte

Aujourd'hui, chaque app downstream a sa propre **page de login fallback** :
- `notifuse.app.veridian.site/signin`
- `prospection.app.veridian.site/login`
- `analytics-engine.staging.veridian.site/login`
- `cms.veridian.site/admin/login`

Ces pages exposent souvent un formulaire email+password (ou un input magic
link). **Aucune ne propose les boutons "Continuer avec Google" ou "Continuer
avec Microsoft"** alors que c'est l'attendu utilisateur en 2026.

Pour des raisons de **maintien dette tech zéro et de cohérence identité
Veridian centralisée**, le bon pattern n'est **pas** d'implémenter OAuth dans
chaque app, mais de **rediriger vers `app.veridian.site/login`** quand
l'user veut un OAuth flow.

## Spec à appliquer dans chaque app

### Page login fallback de l'app downstream

```tsx
// Exemple pour notifuse.app.veridian.site/signin
<SignInForm>
  {/* Form magic link Notifuse existant */}
  <EmailInput />
  <SubmitButton />

  {/* NOUVEAU : bouton qui redirige vers Hub */}
  <Separator>Ou continuer avec</Separator>

  <Button
    onClick={() => {
      const currentUrl = encodeURIComponent(window.location.href);
      window.location.href = `https://app.veridian.site/login?next=${currentUrl}`;
    }}
  >
    <GoogleLogo /> Continuer avec Google
  </Button>

  <Button onClick={/* idem mais avec Microsoft */}>
    <MicrosoftLogo /> Continuer avec Microsoft
  </Button>
</SignInForm>
```

### Flow utilisateur

1. User arrive sur `notifuse.app.veridian.site/signin`
2. Click "Continuer avec Google"
3. Redirect vers `app.veridian.site/login?next=https://notifuse.app.veridian.site/signin`
4. Hub flow OAuth Google → session Hub créée
5. Hub détecte le `?next=` → vérifie qu'il s'agit d'un domaine `*.veridian.site` (anti open-redirect)
6. Hub appelle `POST notifuse/api/workspaces/<id>/generateMagicLink` avec le user_id Hub
7. Hub redirige vers le magic link Notifuse retourné
8. User atterrit sur Notifuse, session Notifuse créée

### Côté Hub à câbler

- [ ] Ajouter le param `?next=<encoded_url>` au `LoginForm.tsx` Hub
- [ ] Whitelist domaine `*.veridian.site` côté server pour éviter open-redirect
- [ ] Après OAuth réussi côté Hub :
      - Si `next` pointe vers une app downstream → appeler son
        `generateMagicLink` et rediriger vers le résultat
      - Sinon → redirect normal `/dashboard`

### Côté chaque app downstream

- [ ] Modifier UI page login : ajouter 2 boutons "Continuer avec Google" +
      "Continuer avec Microsoft" qui redirigent vers Hub avec `?next=`

## Tickets dérivés à créer (cross-app)

- [ ] `notifuse-veridian/todo/...-add-oauth-buttons-login-page.md`
- [ ] `veridian-prospection/todo/...-add-oauth-buttons-login-page.md`
- [ ] `veridian-analytics/todo/...-add-oauth-buttons-login-page.md`
- [ ] `veridian-cms/todo/...-add-oauth-buttons-login-page.md`

## Effort estimé

- Hub : 1j (param next + whitelist + endpoint relay)
- Chaque app : 0.5-1j (UI buttons + redirect)
- Tests cross-app : 1-2j

## Bloque

Aucune feature business, mais améliore conversions partout.

## Référence

- `CONTRAT-HUB.md` §6bis (Autologin SSO 3 couches) — c'est exactement le
  flow autologin documenté, mais déclenché depuis l'app downstream et non
  depuis le Hub
- Ticket parent OAuth : `todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md`
