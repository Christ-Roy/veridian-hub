# [HUB] OAuth Google — passer Consent Screen en Production + brand verification

> **Type** : Config Google Cloud Console — action humaine Robert (pas de code)
> **Sévérité** : 🔴 P1 immédiat (débloque les signups Google publics) + 🟡 P2 follow-up (brand verification)
> **Owner** : Robert (action manuelle Google Cloud Console)
> **Créé** : 2026-05-21

## Pourquoi maintenant

OAuth Google + Microsoft Sign-in Hub livré 2026-05-20 (commit suite,
ticket `done/2026-05-20-oauth-signin-google-microsoft-cross-app.md`).

**État actuel** :
- ✅ Microsoft : **fonctionne pour TOUS** (Outlook, Hotmail, Live, Xbox,
  comptes Microsoft 365 Work/School) sans aucune validation Microsoft.
  Multi-tenant, secret valide jusqu'au 2028-05-20.
- ⛔ Google : **mode Testing** avec 12 test users autorisés. Tout autre
  user voit l'écran rouge "Access blocked: veridian-preprod has not
  completed the Google verification process" — bloqué dur, pas de bypass.

Pour ouvrir au public sans risque, il faut :
1. **Publish app** (instantané, sans review — débloque tous les users Google)
2. **Brand verification** (asynchrone 2-3j review, retire le warning UI)

Les deux sont **indépendants** : on peut publish maintenant sans brand
verification, les users verront juste un screen un peu moche ("Veridian
hasn't verified with Google yet" + bouton "Continue").

## Phase 1 — Publish app (instantané, ZÉRO risque de refus)

### Pré-requis à valider AVANT de cliquer Publish

Dans `console.cloud.google.com` → projet `veridian-preprod` →
APIs & Services → OAuth consent screen :

- [ ] **Publishing status** = `Testing` → vérifier que tu peux cliquer
      `PUBLISH APP`
- [ ] **User type** = `External` (déjà le cas, sinon impossible de
      publish)
- [ ] **App name** = `veridian-preprod` ou `Veridian` ? À renommer en
      `Veridian` (l'app name est visible sur l'écran de consent —
      `veridian-preprod` casse l'image de marque).
- [ ] **User support email** = `robert.brunon@veridian.site` ou
      `support@veridian.site` (pas Gmail perso si possible — image pro)
- [ ] **App logo** : optionnel mais recommandé. PNG 120x120 carré,
      < 1MB. À mettre une icône `V` Veridian propre. Si absent, Google
      affiche un placeholder générique.
- [ ] **Authorized domains** :
      - `veridian.site` (apex)
      - Pas besoin de sous-domaines (les redirect URIs sont déclarées
        côté Client ID séparément)
- [ ] **Developer contact information** = email humain valide
      (probablement même que support email)

### Pré-requis Application Privacy & Terms

C'est là que c'est souvent grisé. Google **EXIGE** ces 2 URLs publics
pour publier :

- [ ] **Application home page** : `https://app.veridian.site`
      (déjà live, OK)
- [ ] **Application privacy policy link** : URL publique vers une page
      Privacy Policy.
      ⚠️ **À VÉRIFIER** : existe-t-elle déjà côté Hub ? Sinon créer
      `https://app.veridian.site/privacy` (page statique minimale OK
      pour Google — voir spec contenu plus bas).
- [ ] **Application terms of service link** : URL publique vers Terms
      of service. Même remarque, créer `https://app.veridian.site/terms`
      si absent.

### Contenu minimal Privacy Policy (RGPD-compliant)

Si à créer côté Hub (page Next statique) :

```
1. Identité du responsable de traitement : Veridian, robert.brunon@veridian.site
2. Données collectées via OAuth Google :
   - email, nom, image profil (scopes: openid email profile)
   - utilisées UNIQUEMENT pour identifier l'utilisateur sur la plateforme
   - JAMAIS revendues, JAMAIS partagées hors Veridian
3. Base légale : exécution contrat (CGU) + consentement (OAuth Google explicite)
4. Durée de conservation : compte actif + 36 mois après suppression (logs audit)
5. Droits utilisateur : accès, rectification, effacement, portabilité — contact
   robert.brunon@veridian.site
6. Sous-traitants : Stripe (paiements), Notifuse (emails), Google (auth OAuth),
   Microsoft (auth OAuth), Cloudflare (hébergement)
7. Cookies : session Auth.js (essentiel), pas de tracking publicitaire
8. CNIL : registre de traitement à disposition sur demande
```

### Contenu minimal Terms of Service

```
1. Objet : SaaS Veridian pour gestion clients, emails, analytics, prospection
2. Acceptation : créer un compte = accepter les CGU
3. Compte utilisateur : email valide, password ≥8 chars OU OAuth Google/Microsoft
4. Tarification : abonnement Stripe mensuel/annuel (pas de remboursement
   pro rata après début mois)
5. Suspension/résiliation : Veridian peut suspendre un compte en cas
   d'abus, fraude, ou non-paiement
6. Responsabilité : service "tel quel", best-effort, pas de SLA contractuel
   en plan gratuit
7. Loi applicable : France
8. Contact : robert.brunon@veridian.site
```

→ Ces 2 pages doivent être **statiques Next** sous `app/(marketing)/`,
indexables (pas de robots.txt block), accessibles sans login.

### Procédure Publish (5 minutes)

1. Console Cloud → OAuth consent screen → bouton **PUBLISH APP**
2. Modale de confirmation : "Your app will be available to any user
   with a Google Account"
3. Clic OK
4. **Immédiat** : le mode passe à `In production`, tous les users
   Google peuvent se logger
5. Le screen "Verification status: Verification not required" apparaît
   (en bas de la page) — pas besoin de soumettre quoi que ce soit
   tant qu'on reste sur `openid email profile`

### Vérification post-publish

- [ ] Logger avec un compte Google qui n'est PAS dans la liste test users
- [ ] Vérifier qu'on ne voit PLUS l'écran rouge "Access blocked"
- [ ] On voit le screen consent normal "Veridian wants to access:
      basic profile info, email"
- [ ] Click "Continue" → arrive sur `/dashboard` du Hub, user créé
      automatiquement
- [ ] Smoke prod : `curl -i https://app.veridian.site/api/auth/signin/google`
      → 302 vers `accounts.google.com/o/oauth2/v2/auth?...`

## Phase 2 — Brand verification (asynchrone, follow-up tranquille)

Une fois publié, Google montre un écran "Veridian hasn't verified with
Google yet" + petit bouton "Continue" caché derrière "Advanced". C'est
moche mais fonctionnel. Pour retirer ce warning, demander la **brand
verification** :

### Conditions Google pour brand verification

- [ ] **Privacy policy publique** (Phase 1)
- [ ] **Terms of service publics** (Phase 1)
- [ ] **App logo PNG 120x120** uploadé
- [ ] **Authorized domains** = `veridian.site` (déjà fait)
- [ ] **Homepage** = `https://app.veridian.site` → doit afficher un site
      Veridian-branded clair (logo, description, lien vers privacy/TOS)
- [ ] **Vidéo de démo YouTube** (optionnel mais accélère le review) :
      30s qui montrent un user qui clique "Continuer avec Google" sur
      le Hub, voit le consent screen, atterrit sur le dashboard
- [ ] **Justification scopes** : remplir le champ "Why do you need these
      scopes?" → "We use openid, email, profile to identify users on
      our SaaS Veridian platform — no data sold, no third-party sharing."

### Procédure submission

1. Console Cloud → OAuth consent screen → bouton **Prepare for
   verification** (apparaît après publish)
2. Remplir le formulaire (5-10 min si tout est prêt)
3. Soumettre → email confirmation Google
4. Review : **typiquement 2-3 jours ouvrés** pour scopes non-sensitive
   (jusqu'à 4-6 semaines pour scopes sensitive — pas notre cas)
5. Response Google :
   - ✅ Approved → "Verified by Google" mention sur le consent screen
   - ⚠️ Need clarification → email avec détails, on répond, re-review
   - ❌ Rejected → email avec raison (très rare pour scopes basic)

### Pas de risque de refus si

- Privacy policy + ToS existent vraiment et sont accessibles publiquement
- App logo professionnel uploadé
- Homepage `app.veridian.site` montre clairement "Veridian SaaS" (pas
  une page blanche)
- Tu utilises uniquement les scopes `openid email profile`
- Tu n'as pas de pratique douteuse (data sharing tiers non-déclaré,
  scope creep, etc.)

## Phase 3 — Suppression test users (après brand verification)

Une fois en production + brand verification approved :

- [ ] Console Cloud → OAuth consent screen → Test users → vider la liste
      (les 12 test users actuels)
- [ ] Plus de notion de test users en mode production de toute façon

## Notes Microsoft (rappel)

Pas d'équivalent "publish/test users" côté Microsoft :
- ✅ Multi-tenant + comptes personnels déjà configuré → fonctionne pour
  tous les users Microsoft (Outlook, Hotmail, Live, MS 365 Work/School)
- ⚠️ Un user d'un tenant Entra qui a la policy "approve external apps"
  pourra voir un écran "Need admin approval" — c'est la policy de leur
  boîte, pas un problème côté Hub. Rare et acceptable.
- Secret current expire 2028-05-20 (rappel mémoire
  `reference_microsoft_entra_oauth.md`)

## Mémoire à mettre à jour après publish

- [ ] `memory/project_oauth_signin_phase1_livre_2026-05-20.md` → ajouter
      "Publish production effectué le YYYY-MM-DD"
- [ ] Créer note follow-up brand verification (si pas done immédiat)

## Lien

- Ticket origine : `todo/done/2026-05-20-oauth-signin-google-microsoft-cross-app.md`
- Mémoire OAuth state : `project_oauth_signin_phase1_livre_2026-05-20.md`
- Doc Google officielle : https://support.google.com/cloud/answer/13463073

## Effort

- Phase 1 publish : ~30 min (créer pages privacy/terms si absentes) + 5 min Google Console
- Phase 2 brand verification : ~1h prep + 2-3j review Google
- Total bloquant immédiat : 30 min
