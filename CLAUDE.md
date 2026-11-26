# Hub SaaS Veridian

> ## 🔴 Règle d'or Veridian — zéro contournement (gravée Robert 2026-06-10)
> **Interdit absolu** : cron bricolé, store parallèle, job maison pour ÉVITER l'API ou la base réelle de l'app. Coder → staging →
> test lourd → prod. Un blocage (accès, credential) se débloque via le lead, il ne se contourne pas.


## Ce que c'est

Inscription, facturation (Stripe) et ouverture des apps de chaque organisation. Next.js 15, Auth.js v5, Prisma 7 (pg-saas, base `hub`,
schéma `hub_app`), shadcn/Tailwind, Brevo pour les mails transactionnels (`lib/email/send.ts`).

## Session et identité

Le Hub est la seule source des utilisateurs des apps. Contrat : `docs/CONTRAT-HUB.md` §3.8 et §6bis.8.0.

- **Session d'un an, glissante.** La révocation se lit en base dans le callback `jwt` de `auth.ts`,
  sur `authAt`. Jamais sur `iat` : Auth.js le réécrit à chaque lecture, middleware compris (faille
  mesurée en prod le 07/11).
- **Preuve récente** : `lib/auth/recent-auth.ts` (24 h compte et admin, 7 j facturation).
- **Rebond** : `api/auth/bounce/prepare` et `complete`. Anti-boucle par app, sur 30 s, jamais remis à
  zéro sur `complete`. Aucun lien hors d'une adresse prouvée.
- **Batterie** : `pnpm test:systeme` (`SSO_NAVIGATEUR=distant`), depuis le bastion, sur ce qui est servi (staging : `HUB_URL=…`). Après une
  modification, rejouer chaque `SSO_SABOTAGE=<scénario>` : il doit échouer. Elle échoue s'il reste un compte. Les essais 48, 49 et la
  **recette de A à Z** (cas 50, prod, une organisation jetable, tableau et captures dans `.run/recette/`) ne tournent que nommés (`… 50-`).
  « Servi » = déploiement Nomad `successful`, jamais le seul `/api/health` (le canari répond avant la bascule). Pendant qu'elle tourne,
  ni ses specs ni ses scripts ne se modifient : bash relit un script en cours (26/11).
- **Signature vers les apps** (26/11) : `lib/hmac/signature-hub.ts`, seul signataire. `HMAC_V2_APPS` (job) liste les apps en v2 (méthode,
  chemin, query, empreinte du corps, usage unique : ts neuf à chaque essai) ; vide = v1. Prod : les cinq apps (CRM le 26/11) ; n'ajouter une app qu'après
  sa vérification v2 servie ET mesurée. Une app ferme la v1 après un jour sans v1 reçue.
- **Rebond refusé** : jamais muet (08/11, Robert renvoyé sans un mot). Tout refus va sur `/auth/bounce/error` qui
  l'explique (`user_not_in_app`, `hub_user_conflict` : un compte d'app n'appartient qu'au premier compte Hub relié),
  et laisse `[bounce][refus]` (app, code, hub_user_id, jamais l'adresse) ; un succès, `[bounce][reussi]`. Batterie : `09-adresses` ; `10-creation`
  (OAuth jusqu'au fournisseur ; inscription pendant un déploiement : `SSO_PENDANT_DEPLOIEMENT=1 … 10-` après un push).
- **Variables du job** : toute variable lue par le code est rendue par `deploy/hub.nomad.hcl` (source de la CI) ou
  déclarée facultative avec sa raison (`__tests__/contrat/variables-job.test.ts`). Une clé de `nomad/jobs/hub` se pose AVANT le déploiement qui la rend.
- **Essai** : le 5e mail Notifuse nourrit `tenant_trials` ; le tick (30 min) n'active qu'à 48 h. Drapeau
  `TRIAL_MACHINE_ENABLED` (`lib/trial/flag.ts`) rendu par le template depuis `nomad/jobs/hub` : absent = 1, seul `0` coupe.
  **Couper** : clé à 0 (écriture du bloc : voir `AUTH_SECRET` plus bas), puis `nomad-v run hub`.
- **Academy** (22/11, Robert seul) : espace comme le CRM (`lib/apps/espace-app.ts`, tenant créé s'il manque).
  Sans `hub app-access <email> --app academy --enabled true` : ni tuile, ni rebond, ni MCP. Grille propre,
  plans à la main, hors Stripe et essai. Secret : `ACADEMY_HUB_API_SECRET` de `nomad/jobs/hub`.
- **Plans d'Analytics et du CRM** : posés par `hub plan --app analytics|crm` et Stripe (`lib/plans/app-plan.ts`),
  avec le statut d'essai. Les apps stockent, rien n'est limité. **Aucun plan par défaut** (22/11) : créer un espace
  ou activer une app ne pose rien (`plan_unset` dans reconcile) ; offert = `grant_manual` hors `free`
  (`estPlanOffert`, même règle chez Twenty). `--plan none` retire un plan. Preuve : cas 14 (staging, Stripe test).
- **Porte MCP** (09/11, `docs/CONTRAT-MCP.md`) : `/api/mcp`, 4 outils pour toutes les apps. Le Hub est serveur OAuth
  et registre (`hub mcp-app add`), ne code aucun outil d'app, présente à l'app un JWT ES256 (`MCP_SIGNING_JWK`).
  `tenant_id` signé seulement si l'IA choisit un espace ; espace non relié → `hub relier --app <app>`. Liens d'ajout : `GET /api/mcp/liens-installation` (public).
- **Mode programme** (24/11, VER-241) : le code d'un client tourne dans le groupe `programme` (rise), sans réseau ni secret ;
  anciens clients par `hub.executer_programme`. Fermé par défaut : seule `app/api/mcp` l'offre. Preuve : `scripts/epreuve-programme.sh
  hub`, cas 18 à 20. Une app qui coupe ses réponses lit `X-Veridian-MCP-Appel`.
  Trace : début et fin au journal, `hub raw GET programmes` ; cas 20 jamais pendant un programme client.
- **Mon IA** (`docs/MON-IA.md`) : le connecteur d'abord, jamais de clé proposée ; clé = chat natif du CRM (`/api/ia/v1`).
  Fenêtre affichée seulement si elle répond (`POST /api/ia/etat`, §5.24.1, cas 55). `hub ia brancher <email> --fournisseur <f> --depuis <VARIABLE>`.
- **Appartenance, rôle, délégation** (VER-245, contrat §5.19.3 à §5.19.5) : `lib/tenants/membres.ts` seul écrivain de
  `tenant_members`. Rôle porté aux apps (`ROLE_PORTE`) : fermé sans Robert. Liaisons (`DELEGATION_CIBLES`) : ouvertes, éteintes jusqu'au
  clic du propriétaire ; jamais de jeton à `act` sans « garde servie ». Organisation unique (§5.19.6, `hub org`). Cas 21 à 26.
- **Adresses** (§5.19.6 à 8) : changement fermé chez Academy et pour un compte non relié ; l'ancienne adresse annule 72 h. 30 à 33, 42.
- **Fournisseur d'une organisation** (§5.19.6) : OIDC ou SAML, `hub org idp` ou à l'écran (essai d'abord). Session bornée à l'organisation. 39, 41.
- **Connexion obligatoire** (§5.19.6, VER-261) : `hub org connexion`. Toute lecture d'espaces prend une `Preuve` (`lib/federation/obligation.ts`). 46.
- **Connexions extérieures** (`docs/CONNECTEURS.md`) : FERMÉES (Robert ouvre), aucun appel réel en épreuve. 43.
- **CSP** (VER-265) : nonce (`lib/security/csp.ts`), bloquante (`CSP_MODE=appliquer`, retour `rapport`) ; rapports `[csp_violation]` ;
  garde : cas 52 ; zod sans eval (`lib/zod-sans-eval.ts`).
- **Garde rapide** : `__tests__/contrat/` (révocation sans `iat`, `authAt`, rebond, origines) ; tout nouvel
  `encode(` de JWT de session s'y ajoute. Détail : `docs/PARCOURS-IDENTITE.md`.
- **Sonde de prod** : « Sonde identité » de `hub-ci.yml` ; reconcile alerte au-dessus de `RESIDUE_SEUIL` (0).
- **Coupure** : aucune (pg-saas Patroni, bleu-vert). Tags Traefik : 12 s de coupure, regrouper. La batterie ne redéploie rien.

## Que faire si

Outil admin : `hub` (`hub doctor` d'abord : santé, secret, auth admin). Aucune de ces commandes n'affiche de secret.

- **Un client ne peut plus se connecter** : `hub tenant <email>` (adresse prouvée ? apps liées ?), `hub audit --since <date>`.
  Adresse non prouvée : aucun lien d'app, `hub invite <email>` renouvelle l'accès (`--no-email` : lien seul). Entrer chez lui : `/dashboard/admin/clients` ou `hub open <email>` (cas 45). Admin dans ses espaces, jamais propriétaire, jamais remis après un retrait : `hub admin-partout` (§5.23).
- **Un rebond échoue** : `/auth/bounce/error?code=` dit pourquoi (`not_configured` : variable `<APP>_API_URL` ou
  `<APP>_HUB_API_SECRET` absente du job ; `unreachable` : l'app ; refus d'identité : voir « Rebond refusé »).
  `nomad-v logs hub` (tag `[bounce][refus]`). 3 rebonds rapides : anti-boucle, 30 s.
- **Le Hub est en 502** : `nomad-v state`, `nomad-v allocs hub`. Après un **reboot de nœud**, le réseau CNI n'est pas
  reconstruit : `nomad-v run hub` ne répare rien et `hub-selfheal` non plus. Runbook :
  `~/.claude/skills/nomad/reference/cluster-ops.md`, section « Piège CNI orphelin » (`nomad-v raw job restart -reschedule -yes hub`,
  puis purge des DNAT orphelins).
- **Couper un compte en urgence** : `hub app-access <email> --app twenty|analytics|cms --enabled false`, `hub unlink <email> --app <app>`
  ou `hub delete-tenant <email> --confirm` (irréversible, propage aux apps). Membre : `hub membre retirer` ; organisation :
  `hub suspension poser` (0 coupé et relu, 1 une app n'a pas suivi ; §5.19.3). Sessions : le client les coupe.
- **Cookie volé suspecté** : le client « se déconnecte partout » (coupe Hub et apps, la réponse nomme les apps en échec) ;
  changer son mot de passe fait pareil. Un cookie simplement déconnecté reste valable jusqu'à expiration.
- **`AUTH_SECRET` à changer** : coupe TOUTES les sessions du Hub et les rebonds en cours ; ne coupe pas les sessions
  déjà ouvertes dans les apps. Secret dans la Nomad Variable `nomad/jobs/hub` (une écriture remplace le bloc entier). Y toucher en
  prod par `nomad-v raw` (jeton de management) est SUSPENDU (24/11) sans l'accord de Robert. Puis `nomad-v run hub`.
- **Restes de test** : `hub reconcile` (`testResidue.total`) et, par app, `scripts/orphelins-e2e.sh` (skill hub-admin).
  `delete-tenant` déprovisionne les espaces des apps (`lib/apps/deprovision.ts`) et laisse une trace d'audit.
  Le cron alerte au-dessus de `RESIDUE_SEUIL`. La batterie les retire elle-même et échoue s'il en reste.
- **Batterie rouge** : `e2e/systeme-sso/.run/resultat.txt`. ÉCHOUE = vrai défaut ; NON ABOUTI = pas mesuré (Hub en déploiement, jeton
  Nomad, compte non créé). Un filtre : `bash scripts/test-systeme-sso.sh 08-`.
- **Jeton Nomad 403** : `nomad-v` relit `~/credentials/nomad-bastion.env` ; `nomad-v acl status`. Jamais le jeton management.

## Où travailler (18/11)

Dossier principal, sur `main`, jamais en worktree ; `git fetch && git status -sb` sans écart avant de commencer.
Dév : `dev -d <domaine> pnpm dev` · `pnpm test` (nice 19).

## Déploiement : la prod vient de `main`

`staging` et `main` divergent ; `scripts/pousser-staging.sh` y porte `main` et refuse un conflit. `auto_revert` sur `stack` seul : CI rouge, lire « Groupe en cause ». La CI pose `deploy/hub.nomad.hcl` depuis `main`. La version servie
se lit avec `nomad job inspect hub`, jamais dans le miroir `~/nomad-veridian/jobs/saas-prod/`.
Un audit CVE ou un test rouge saute le déploiement sans bruit : lire `gh run view`, puis l'image.

## Règles

- `hub_user_id` = `users.supabase_user_id`, jamais `users.id` (cuid sur la moitié des comptes).
- Toute route qui mène à une session d'app appelle `denyUnlessEmailProven` (`lib/auth/email-proof.ts`) ; un test le garde.
- `hub reconcile` (`lib/sync/`) n'écrit rien : une dérive se lit et se tranche (comptes de chaque app comparés au Hub).
- Toute écriture de plan se propage à l'app. Un refus n'écrit rien au Hub.
- Un tenant supprimé n'est jamais repris par une recherche par `userId` (`__tests__/contrat/tenant-supprime.test.ts`).
- Le dépôt est **public**, ses logs Actions aussi : aucune adresse client dans une réponse de cron.

- Les env vars **runtime** viennent du job Nomad (`deploy/hub.nomad.hcl`, secrets `nomad/jobs/hub`), jamais de build-args.
- Stripe = source de vérité billing. Config dans `lib/stripe/`.
- Couleurs : tokens OKLCH.
- `/api/health` reste disponible (garde du déploiement et sonde de la CI).

## 💰 Pricing & trial

**Source de vérité** : `docs/PRICING-VERIDIAN.md`, à lire avant de toucher au pricing, à l'essai, à Stripe ou aux limites.
Générosité maximale : tout illimité, seules différences la durée Free 15 j et la marque blanche Business+.
Jamais de limite visible. Stripe → Hub → apps, jamais Stripe → app.

## CI/CD

`hub-ci.yml` : test → audit → docker → trivy → deploy-prod (`main`) → e2e-prod-smoke → rollback. CVE de l'image servie : `secu`.
Journaux : jeton de déploiement (`read-logs`) ou Loki (`obs search`). Redeploy `nomad-v run hub`.

