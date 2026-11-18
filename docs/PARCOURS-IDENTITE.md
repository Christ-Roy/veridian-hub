# Parcours d'identité du Hub

> État au 2026-11-07, contrat v1.9 (`CONTRAT-HUB.md` §3.8 et §6bis.8.0). Une page par question :
> « que voit la personne, qu'est-ce qui l'empêche de mal tourner, qui le prouve, et qu'est-ce qu'on
> a accepté sans le prouver ». Les chiffres sont des mesures datées, pas des promesses.

## Lire cette page

Chaque parcours a quatre lignes : **Voit**, **Protège**, **Preuve**, **État**.

| État | Sens |
|---|---|
| PROUVÉ | un test nommé échoue si la chose casse, vu échouer par mutation ou par `SSO_SABOTAGE` |
| ACCEPTÉ | choix assumé, avec sa raison |
| ÉCART | défaut connu, pas corrigé, avec sa raison |
| NON PROUVÉ | rien ne le mesure aujourd'hui |

Les trois niveaux de preuve :

- **Garde rapide**, à chaque push : `__tests__/contrat/` (invariants transversaux) et les tests unitaires
  de `__tests__/lib/auth`, `__tests__/api/auth`. `__tests__/contrat/couverture.test.ts` échoue si l'un
  d'eux disparaît ou change de titre.
- **Batterie système**, à la main depuis le bastion : `pnpm test:systeme`, vrai Chromium contre ce qui est
  servi (`e2e/systeme-sso/README.md`). Épreuve de chaque scénario : `SSO_SABOTAGE=<scénario>`.
- **Sonde de prod**, après chaque déploiement : étape « Sonde identité » de `hub-ci.yml` (lectures seules,
  voir en fin de page).

## Inscription

- **Voit** : formulaire, puis tableau de bord et un mail de preuve d'adresse. Doublon : « adresse déjà
  utilisée » (409). Adresse saisie avec majuscules ou espaces : normalisée avant tout.
- **Protège** : mot de passe 8 à 72 caractères ; limiteur d'inscription ; aucun lien vers une app tant
  que l'adresse n'est pas prouvée (§3.8) ; l'adresse prouvée est celle du compte, pas un jeton générique.
- **Preuve** : `__tests__/api/auth/signup.test.ts` (doublon, 6e essai refusé, bypass E2E inopérant en prod) ;
  `e2e/systeme-sso/02-sans-preuve.spec.ts` (3 apps, témoin positif exigé) ; `__tests__/lib/auth/email-normalize.test.ts`.
- **État** : PROUVÉ. ACCEPTÉ : le 409 dit que l'adresse existe (la page d'inscription le dit déjà).
  Anti-bot : champ piège invisible `hp_reference` (refus 400 si rempli, test unitaire vu échouer), plafond par IP et preuve d'adresse. Pas de captcha, décision de Robert du 07/11.

## Connexion par mot de passe

- **Voit** : tableau de bord, ou la page demandée (`callbackUrl`). Mauvais mot de passe : « email ou mot de
  passe invalide ». Hub injoignable : message « connexion impossible, réessayez ».
- **Protège** : 5 essais par minute par `ip|email` et plafond large par IP, l'IP lue sur `cf-connecting-ip`
  (un `X-Forwarded-For` forgé ne contourne plus) ; email normalisé ; `callbackUrl` limité à un chemin du Hub
  (`lib/auth/safe-callback.ts`) ; `authAt` posé à la connexion.
- **Preuve** : `__tests__/lib/auth/rate-limit.test.ts` (cf-connecting-ip) ; `__tests__/contrat/origines.test.ts` ;
  `__tests__/contrat/authat-creation-session.test.ts` ; `__tests__/components/auth/LoginForm.callback.test.tsx`.
- **État** : PROUVÉ. ACCEPTÉ : les compteurs sont en mémoire d'une seule instance et repartent à zéro à chaque
  déploiement (le Hub tourne à une instance ; à plus d'une, les mettre en base).

## Double vérification (MFA)

- **Voit** : après le mot de passe, la page de code reçu par mail, puis la session.
- **Protège** : cookie signé d'étape 1 (5 min, lié au compte), code à usage unique, 5 essais par fenêtre de
  10 min ; la session n'est émise qu'après le code, avec `authAt`. One Tap refuse un compte à double vérification.
- **Preuve** : `__tests__/api/auth/mfa/verify.test.ts`, `__tests__/lib/auth/mfa-step1.test.ts`,
  `__tests__/lib/auth/sign-in-callback.test.ts` (« D3 : credentials + MFA »).
- **État** : PROUVÉ en test. **0 compte MFA en prod** (mesuré le 07/11) : aucun client n'a jamais traversé
  ce chemin, il n'a donc pas de preuve de bout en bout en prod. La batterie système ne le joue pas.

## Connexion par Google

- **Voit** : bouton Google, retour sur le tableau de bord ou sur la page demandée.
- **Protège** : un compte existant n'est relié que si Google atteste l'adresse (`email_verified`) ou si le
  compte est déjà lié ; une ligne `account` d'un autre utilisateur sur la même adresse est refusée. Une telle
  connexion sur un compte non prouvé annule le mot de passe préexistant et coupe les sessions déjà émises.
- **Preuve** : `__tests__/lib/auth/sign-in-callback.test.ts` (scénarios C, D, E, F « REFUSE (D1) ») ;
  `__tests__/lib/auth/email-proof.test.ts` (OAuth prouvé annule le mot de passe).
- **État** : PROUVÉ en test. Batterie (`10-creation`) : le Hub envoie chez Google et Microsoft avec son adresse
  de retour, et le fournisseur l'accepte (`SSO_SABOTAGE=oauth-retour` doit échouer). NON ABOUTI de bout en bout :
  le consentement demande un humain. **ÉCART Microsoft (mesuré le 08/11)** : l'application Entra n'accepte que les comptes professionnels ;
  un compte Microsoft personnel (celui de Robert) lit `unauthorized_client … not enabled for consumers` chez
  Microsoft. Correctif : audience « comptes professionnels et personnels » dans l'inscription d'application.
  La liaison d'un compte existant exige `xms_edov`, sinon elle est refusée (c'est voulu).

## One Tap

- **Voit** : la bulle Google sur `/login` et les pages vitrines, jamais en mode rebond ni connecté.
- **Protège** : la route `/api/auth/callback/google-one-tap` vérifie le jeton Google (signature, `aud`,
  `exp`, email vérifié), pose `authAt` et la durée d'un an comme les autres sessions, refuse un compte à
  double vérification, limite à 30 requêtes par minute et par IP.
- **Preuve** : `__tests__/api/auth/callback/google-one-tap.test.ts` (« D7 session forgée »).
- **État** : PROUVÉ en test. NON PROUVÉ sur Android : FedCM n'a pas été rejoué sur le Chrome du téléphone
  (voir « Téléphone »).

## Mot de passe oublié

- **Voit** : la même réponse que l'adresse existe ou non ; un lien de réinitialisation valable 1 h.
- **Protège** : jeton haché en base, consommé de façon atomique (deux clics simultanés : un seul passe) ;
  plafond par adresse (4 par heure) ; le reset prouve l'adresse, coupe toutes les sessions du Hub et demande
  aux apps de couper les leurs (`revoke_sessions`).
- **Preuve** : `__tests__/api/auth/reset-password.test.ts` (énumération, expiration, usage unique, révocation).
- **État** : PROUVÉ. ACCEPTÉ : une cible peut être empêchée de redemander par le plafond (mail-bombing évité).

## Preuve d'adresse

- **Voit** : une page « confirmer » à ouvrir connecté sur son compte, un bouton, puis la confirmation.
- **Protège** : lien valable 48 h, haché, lié à l'adresse pour laquelle il a été émis (un changement d'adresse
  l'invalide) ; il exige la session du compte, donc un scanner de mail n'est pas un clic ; confirmation par POST ;
  un seul mail par 10 min et par adresse.
- **Preuve** : `__tests__/lib/auth/email-proof.test.ts` ; `__tests__/lib/auth/email-proof-routes.test.ts` (toute
  route qui fabrique une session d'app est gardée) ; `e2e/systeme-sso/02-preuve-mail.spec.ts` et `03-liens-morts.spec.ts`
  (consommé, inconnu, expiré, impersonation).
- **État** : PROUVÉ.

## Rebond vers une app (connexion automatique)

- **Voit** : ouvrir Notifuse, Prospection, Analytics ou Twenty avec une session Hub ouverte arrive connecté sur la
  page demandée, sans saisie. Sans session Hub : l'écran de connexion du Hub, puis le retour sur la page demandée.
  Adresse non prouvée : le tableau de bord du Hub et le lien de preuve.
- **Protège** : seules les apps déclarées dans `APP_ENV_MAP` sont des cibles, un site client sous `veridian.site`
  est refusé ; `next` limité à `<app>.app.veridian.site` (staging à part, `DEPLOY_ENV=prod` compris) ; cookie
  `next` signé de 10 min ; le lien rendu par l'app est revérifié (https, `*.veridian.site`) ; adresse prouvée
  vérifiée avant tout appel à l'app ; `hub_user_id` jamais `users.id` ; rebond refusé hors navigation de page
  (iframe, fetch, préchargement : 204 sans rien émettre) ; **anti-boucle par app sur 30 s : le 3e `auto=1` est
  rendu à l'app sur la page demandée (qui affiche sa connexion), le 4e s'arrête sur `/login?bounce_failed=1`** ;
  ouvrir trois outils à la suite n'est pas une boucle.
- **Preuve** : `__tests__/contrat/rebond-redirections.test.ts`, `origines.test.ts` ; `__tests__/api/auth/bounce/prepare.test.ts`
  et `complete.test.ts` ; `e2e/systeme-sso/04-rebond.spec.ts`, `08-session-longue.spec.ts` (session ouverte, absente,
  expirée, iframe, anti-boucle, rebonds rapprochés). Sonde de prod : prepare sans session, site client, hôte étranger, iframe.
- **État** : PROUVÉ pour Notifuse, Prospection, Analytics. **Twenty : prouvé sur son staging seulement**
  (`HUB_URL=https://hub.staging.veridian.site`), pas en prod. Le côté app du contrat (cookie d'essai unique,
  cookie de déconnexion explicite) n'est pas relu par ce dépôt : voir le contrat de chaque app, `CONTRAT-HUB.md` §6bis.8.0.

## Adresse différente de l'app, plusieurs comptes Hub

- **Voit** : un compte d'app relié par `hub_user_id` s'ouvre quelle que soit l'adresse au Hub. Une app qui ne
  connaît pas le compte : page « Pas encore d'accès » qui nomme l'adresse de la session. Un second compte Hub de la
  même personne : « Accès rattaché à un autre compte ». Les deux proposent de changer de compte et le support.
- **Protège** : l'app joint par `hub_user_id`, puis par l'adresse prouvée ; un compte d'app ne change jamais de
  compte Hub (le premier relié le garde). Chaque refus : ligne `[bounce][refus]` (app, code, hub_user_id).
- **Preuve** : `__tests__/api/auth/bounce/complete.test.ts` (refus expliqué, journal sans l'adresse),
  `bounce-apps.test.ts` (`hub_user_conflict`) ; `e2e/systeme-sso/09-adresses.spec.ts` (le cas de Robert du 08/11,
  `SSO_SABOTAGE=adresse-liee|conflit|inconnu`).
- **État** : PROUVÉ pour Analytics. Relier un compte d'app à une autre adresse se fait à la main (08/11 : le compte
  Rybbit de Robert relié à son compte Hub veridian.site). Regrouper des comptes Hub : décision humaine.

## Déconnexion

- **Voit** : retour à la page de connexion, y compris dans l'app d'où l'on se déconnecte ; aucune reconnexion
  silencieuse ensuite tant qu'on n'a pas cliqué « Continuer ».
- **Protège** : cookie local de l'app posé au clic « Se déconnecter », levé à la connexion suivante ; cookie
  hint du Hub effacé.
- **Preuve** : `e2e/systeme-sso/08-session-longue.spec.ts` (`SSO_SABOTAGE=logout`) ; `__tests__/lib/auth/sign-out-with-hint-clear.test.ts`.
- **État** : PROUVÉ. ACCEPTÉ : un cookie volé reste valable jusqu'à expiration après une simple déconnexion ;
  « déconnecter partout » existe pour l'urgence.

## Déconnecter partout

- **Voit** : confirmation, puis plus aucune session ouverte, ici ni dans les apps. Si une app n'a pas confirmé,
  le message le dit (« déconnecté du Hub, X sera coupé sous peu »).
- **Protège** : `sessions_valid_after` posé ; chaque lecture de session compare `authAt` (la connexion réelle),
  **jamais `iat`**, que Auth.js réécrit à chaque lecture ; les apps reçoivent `revoke_sessions: true`, et le Hub
  rend la liste des apps qui n'ont pas confirmé (`failed`, `endpoint_missing`). Une coupure perdue sur un redémarrage
  d'app est réessayée.
- **Preuve** : `__tests__/contrat/revocation-sans-iat.test.ts` ; `__tests__/lib/auth/session-revocation.test.ts`,
  `revoke-all-sessions.test.ts` ; `e2e/systeme-sso/08-session-longue.spec.ts` (`SSO_SABOTAGE=partout`, cookie rejoué).
- **État** : PROUVÉ app UP. App DOWN : le Hub l'annonce, la session d'app reste valable tant qu'elle n'a pas reçu
  la coupure (réessai à la prochaine coupure, pas de file de rejeu). ACCEPTÉ : base injoignable, la lecture de
  révocation ouvre au lieu de fermer (on ne déconnecte personne sur une panne passagère, le Hub ne sert alors plus rien).

## Session expirée

- **Voit** : l'écran de connexion, puis le retour sur la page demandée.
- **Protège** : session glissante d'un an, un an d'inactivité déconnecte ; jeton sans `authAt` : révoqué dès
  qu'une révocation existe ; impersonation : une heure après son début réel, quoi que dise la durée re-signée.
- **Preuve** : `08-session-longue.spec.ts` (expirée refusée, même jeton non expiré accepté ; cookie d'un an renouvelé à
  l'usage) ; `__tests__/lib/auth/impersonation.test.ts` ; `__tests__/contrat/authat-creation-session.test.ts`.
- **État** : PROUVÉ. ÉCART : après une révocation côté Hub, `dashboard/layout.tsx` renvoie sur `/login` sans
  `callbackUrl` ; la page demandée au Hub est perdue (celle d'une app ne l'est pas).

## Compte supprimé

- **Voit** : plus d'accès nulle part, même cookie en main.
- **Protège** : ligne absente = jeton révoqué (impersonation comprise) ; `deleted: true` poussé aux apps, qui coupent sessions et accès.
- **Preuve** : `08-session-longue.spec.ts` (`SSO_SABOTAGE=supprime`) ; `session-revocation.test.ts`.
- **État** : PROUVÉ.

## Membre retiré d'un workspace

- **Voit** : le membre disparaît de la liste.
- **Protège** : sessions et tenants sont par utilisateur, pas par workspace.
- **Preuve** : aucune.
- **État** : ÉCART au contrat. La route `DELETE /api/workspace/members/[id]` supprime la ligne du Hub et rien
  d'autre : pas d'appel `remove-member` (§5.19), pas de coupure de sessions. Ce que le retrait ouvre ou ferme dans
  les apps n'est pas établi (apps non lues). À trancher avec les apps avant de décider entre corriger le code ou le contrat.

## Plan et tenant

- **Voit** : le plan posé au Hub est celui qu'affichent Prospection et Notifuse, dans les deux sens.
- **Protège** : toute écriture de plan se propage à l'app, un refus n'écrit rien au Hub ; Stripe → Hub → apps,
  jamais Stripe → app ; preuve récente de 7 jours pour la facturation (checkout et recharge de leads).
- **Preuve** : `e2e/systeme-sso/05-plan.spec.ts`, `05-synchro-identite.spec.ts` (nom et email relus dans chaque app),
  `07-isolation.spec.ts` ; `__tests__/lib/auth/recent-auth-routes.test.ts`.
- **État** : PROUVÉ pour ce qui est posé au Hub. Analytics et Twenty : le Hub ne pose pas de plan, cas NON ABOUTI par
  construction. NON PROUVÉ : webhooks Stripe, trial, double clic sur « commencer l'essai » (pas de verrou).

## Retour sur la page demandée

- **Voit** : après connexion, la page qu'on voulait, pas l'accueil.
- **Protège** : `callbackUrl` du Hub : chemin interne seulement (`//hote`, `/\hote`, `javascript:` refusés) ;
  `next` des apps : origine d'une app déclarée seulement ; l'app ne renvoie sur `next` que s'il est sur son origine.
- **Preuve** : `__tests__/contrat/origines.test.ts` ; `08-session-longue.spec.ts` (absente puis connexion et retour).
- **État** : PROUVÉ. ÉCART : un utilisateur déjà connecté qui ouvre `/login?callbackUrl=…` est renvoyé sur `/dashboard`.

## Téléphone

- **Voit** : la même chose, sur mobile.
- **Protège** : rien de spécifique.
- **Preuve** : aucune dans la batterie.
- **État** : NON PROUVÉ, accepté. À rejouer avec le CLI `android` (One Tap FedCM, rebond sur le Chrome du téléphone).
  Les navigateurs intégrés (webviews) sont refusés par Google : hors de notre code.

## Deux onglets

- **Voit** : deux rebonds lancés dans deux onglets vers deux apps : le second écrase le premier.
- **Protège** : l'anti-boucle compte par app ; pas de faille, seulement une mauvaise destination.
- **Preuve** : `prepare.test.ts` (compteur par app).
- **État** : ÉCART assumé. Un seul cookie `next` par navigateur : la connexion de l'onglet A peut atterrir sur l'app de B.

## App en panne

- **Voit** : au rebond, la page `/auth/bounce/error` (« impossible de revenir sur X ») ; jamais de boucle.
- **Protège** : délai de 10 s sur l'appel à l'app ; cookie d'essai unique côté app ; cookie `next` effacé même en erreur
  (un rafraîchissement ne rejoue pas) ; sessions d'app déjà ouvertes : inchangées.
- **Preuve** : `__tests__/api/auth/bounce/complete.test.ts` (400, 404, 5xx, `not_configured`, idempotence).
- **État** : PROUVÉ en unitaire, pas en batterie (app coupée). ÉCART cosmétique : pas de bouton « Réessayer » sur la page d'erreur.

## Hub en panne ou en déploiement

- **Voit** : pendant la coupure, le formulaire affiche un message de connexion impossible ; les sessions d'app
  déjà ouvertes continuent de servir ; le rebond et toute nouvelle connexion échouent.
- **Protège** : une seule instance, donc une **coupure à chaque déploiement : 19 s, 24 s, 51 s (mesures du 07/11)**.
  Regrouper les changements. La batterie attend `/api/health` avant de mesurer ; la sonde de prod reprend chaque
  contrôle trois fois à 8 s. `e2e/systeme-sso/**` ne redéploie rien.
- **Pièges connus** : après un **reboot de nœud**, le réseau CNI des allocations en bridge n'est pas reconstruit
  (`EHOSTUNREACH`, Hub en 502 alors que l'alloc est `running`). Un redéploiement ne répare rien. Runbook :
  `~/.claude/skills/nomad/reference/cluster-ops.md`, section « Piège CNI orphelin après REBOOT ». `hub-selfheal` ne
  le répare pas. Le jeton Nomad hérité du shell peut être révoqué par une rotation : la batterie relit le jeton de lecture.
- **État** : ACCEPTÉ (une instance, coupure mesurée). NON PROUVÉ : le message de panne dans un vrai navigateur
  (test de composant seulement, `LoginForm`).

## Cookies bloqués

- **Voit** : une session ne peut pas se poser ; le rebond sans cookie `next` atterrit sur `/dashboard`, sans boucle.
- **Protège** : aucune session sans cookie par construction ; l'erreur de jeton CSRF n'est plus affichée comme
  « mot de passe invalide ».
- **Preuve** : `complete.test.ts` (cookie absent) ; tests de `LoginForm` (erreurs réseau et de configuration).
- **État** : ACCEPTÉ.

## Horloge décalée

- **Voit** : rien : l'horloge du navigateur n'entre dans aucun contrôle.
- **Protège** : `iat`, `authAt` et les expirations viennent de l'horloge du serveur du Hub ; les cookies du rebond
  ont une durée relative ; la signature Hub → app porte l'horodatage du serveur, fenêtre de ±5 min côté app.
- **Preuve** : lecture du code (`bounce-apps.ts`), aucun test de décalage.
- **État** : ACCEPTÉ. NON MESURÉ : la dérive NTP du Hub par rapport aux apps.

## Impersonation (support)

- **Voit** : l'admin ouvre le compte d'un client pendant une heure, bandeau visible.
- **Protège** : jeton d'impersonation haché, usage unique, 10 min ; session d'une heure à partir de son début réel ;
  hors « déconnecter partout » et hors changement d'email ou de mot de passe ; `authAt` posé.
- **Preuve** : `__tests__/lib/auth/impersonation.test.ts`, `__tests__/api/auth/impersonate-callback.test.ts`.
- **État** : PROUVÉ. ÉCART : `impersonatedBy` porte la chaîne `admin`, pas l'identité de l'admin.

## Comptes de test et restes

La batterie crée `e2e-sso-<run>-<a|b|np>@veridian.site` (nom « TEST SYSTEME SSO »), les note dans
`e2e/systeme-sso/.run/comptes.jsonl` avant usage, ne supprime que ceux-là, et échoue s'il reste quelque chose.
`hub reconcile` mesure les restes (`testResidue` : comptes au Hub, comptes dans chaque app, workspaces de test
Notifuse, tenants sans utilisateur) sans rien supprimer. Retrait : `hub delete-tenant <email> --confirm`
(propage aux apps) puis le workspace Notifuse de test.

**Les trois états de `hub reconcile`** : par app, `ok` (comparé), `endpoint_missing` (l'app n'expose pas
`GET /api/hub/users` : jamais « aucun écart »), `unreachable` (l'app n'a pas répondu : non mesuré). Une app sans
configuration s'affiche `not_configured`. Le total de `testResidue` se lit dans la même réponse.
Au 07/11 : `total = 5`, restes d'autres sessions, connus.

## Ce que la sonde de prod vérifie, et ce qu'elle ne vérifie pas

Étape « Sonde identité » de `.github/workflows/hub-ci.yml`, après chaque déploiement de `main`, lectures seules,
aucun compte : `/login` 200 ; `/api/auth/session` vide sans cookie ; `frame-ancestors` présent ; `prepare` sans
session renvoie sur `/login?mode=bounce&app=…` ; `prepare` vers un site client ou un hôte étranger renvoie sur
`/login` sans mode rebond ; `complete` et `prepare` dans une iframe répondent 204. Un écart fait échouer le job, donc
déclenche le rollback comme le reste du smoke.

Elle ne vérifie ni une connexion réelle ni une session d'app : c'est le rôle de la batterie système.
Rejouer à la main : copier le bloc `run:` de l'étape dans un fichier, `HUB_URL=https://app.veridian.site bash fichier`.
Épreuve : le même bloc contre un serveur local qui dévie d'un seul contrôle doit sortir en 1 (fait pour les huit le 07/11).

Le cron horaire `hub-reconcile-cron.yml` ne publie plus que des comptes dans ses logs (publics) et alerte quand
`testResidue.total` dépasse `RESIDUE_SEUIL` (variable du dépôt, 0 par défaut). Entre 1 et le seuil :
annotation, pas de rouge. Total absent : annotation « non mesuré ».
