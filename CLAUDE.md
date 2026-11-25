# Hub SaaS Veridian

> ## 🔴 Règle d'or Veridian — zéro contournement (gravée Robert 2026-06-10)
> **Interdit absolu** : cron bricolé, SQLite/store parallèle, job maison pour
> ÉVITER l'API ou la DB réelle de l'app. On travaille AVEC le vrai système :
> coder → staging → test lourd → prod. Un blocage (accès, credential) se
> débloque via le lead, il ne se contourne pas.


## Ce que c'est

Le Hub gère l'inscription (Auth.js v5), le billing (Stripe), et le
provisioning automatique des apps pour chaque nouveau tenant (Notifuse,
Prospection). CRM (Twenty) : espace créé par `app-access --app twenty`, entrée par rebond.

## Stack

- Next.js 15 (App Router) + pnpm
- Auth.js v5 (Google OAuth + Credentials bcrypt + MFA email)
- Prisma 7 sur la grappe pg-saas (base `hub`, rôle `hub`, schema `hub_app`)
- Stripe (billing, webhooks, plans)
- shadcn/ui + Tailwind
- Brevo pour les mails transactionnels (`lib/email/send.ts`), Notifuse fork pour les tenants

## Session et identité

Le Hub est la seule source des utilisateurs des apps. Contrat : `docs/CONTRAT-HUB.md` §3.8 et §6bis.8.0.

- **Session d'un an, glissante.** La révocation se lit en base dans le callback `jwt` de `auth.ts`,
  sur `authAt`. Jamais sur `iat` : Auth.js le réécrit à chaque lecture, middleware compris (faille
  mesurée en prod le 07/11).
- **Preuve récente** : `lib/auth/recent-auth.ts` (24 h compte et admin, 7 j facturation).
- **Rebond** : `api/auth/bounce/prepare` et `complete`. Anti-boucle par app, sur 30 s, jamais remis à
  zéro sur `complete`. Aucun lien hors d'une adresse prouvée.
- **Batterie** : `pnpm test:systeme`, depuis le bastion, sur ce qui est servi (staging : `HUB_URL=…`). Après une
  modification, rejouer chaque `SSO_SABOTAGE=<scénario>` : il doit échouer. Elle échoue s'il reste un compte.
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
  anciens clients par `hub.executer_programme`. Fermé par défaut : seule `app/api/mcp` l'offre, jamais Mon IA. Preuve sur ce
  qui est servi : `scripts/epreuve-programme.sh hub` (0/1/2), cas 18 à 20. Une app qui coupe ses réponses doit lire
  `X-Veridian-MCP-Appel`.
- **Mon IA** (VER-203, `docs/MON-IA.md`) : le connecteur d'abord, jamais de clé proposée quand il suffit ; une clé ne sert qu'au chat natif
  du CRM (`/api/ia/v1`). `hub ia brancher <email> --fournisseur <f> --depuis <VARIABLE>`. Ateliers : un par tenant, rise.
- **Appartenance, rôle, délégation** (VER-245, contrat §5.19.3 à §5.19.5) : `lib/tenants/membres.ts` seul écrivain de
  `tenant_members`. Rôle porté aux apps (`ROLE_PORTE`) : fermé sans Robert. Liaisons (`DELEGATION_CIBLES`) : ouvertes, éteintes jusqu'au
  clic du propriétaire ; jamais de jeton à `act` sans « garde servie ». Organisation unique (§5.19.6, `hub org`). Cas 21 à 26.
- **Adresses** (§5.19.6 à 8) : changement fermé chez Academy et par compte non relié ; l'ancienne est prévenue et annule 72 h (`lib/adresses/annulation.ts`). 30 à 33, 42.
- **Fournisseur d'une organisation** (§5.19.6) : OIDC ou SAML, posé par nous (`hub org idp`) ou par le propriétaire à l'écran (sans domaine, essai d'abord). Session bornée à l'organisation. 39, 41.
- **Connexions extérieures** (`docs/CONNECTEURS.md`) : Notion, Linear… par OAuth, sans application à créer. Registre figé dans le code. 43.
- **Garde rapide** : `__tests__/contrat/` (révocation sans `iat`, `authAt`, cibles du rebond, origines) ; tout nouvel
  `encode(` de JWT de session s'y ajoute. Détail : `docs/PARCOURS-IDENTITE.md`.
- **Sonde de prod** : « Sonde identité » de `hub-ci.yml` (lecture seule) ; le cron de reconcile alerte au-dessus de
  `RESIDUE_SEUIL` (0).
- **Coupure** : aucune (08/11). Base sur pg-saas (Patroni), app en bleu-vert (canari, health check Traefik). Changer les
  tags Traefik coupe 12 s : regrouper. `e2e/systeme-sso/**` ne redéploie rien.

## Que faire si

Outil admin : `hub` (`hub doctor` d'abord : santé, secret, auth admin). Aucune de ces commandes n'affiche de secret.

- **Un client ne peut plus se connecter** : `hub tenant <email>` (adresse prouvée ? apps liées ?), `hub audit --since <date>`.
  Adresse non prouvée : aucun lien d'app, `hub invite <email>` renouvelle l'accès (`--no-email` : lien seul). Voir sa vue : `hub open <email>`.
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
- **Batterie rouge** : lire `e2e/systeme-sso/.run/resultat.txt`. ÉCHOUE = vrai défaut (si l'image servie n'est pas
  listée « avant »). NON ABOUTI = on n'a pas mesuré (Hub en déploiement, jeton Nomad, compte non créé). Relancer
  un filtre : `bash scripts/test-systeme-sso.sh 08-`. Épreuve : `SSO_SABOTAGE=<scénario>` doit échouer.
- **Jeton Nomad 403** : une rotation a révoqué celui du shell. `nomad-v` relit `~/credentials/nomad-bastion.env` ;
  `nomad-v acl status` montre les jetons et leurs échéances. Ne jamais se replier sur le jeton management.

## Commandes

Dév : `dev -d <domaine> pnpm dev` · `pnpm test` (2 workers, nice 19).

## Où travailler (18/11)

La session du Hub travaille dans le dossier principal, sur `main` (la branche qui déploie), jamais en
worktree. Avant de commencer : `git fetch && git status -sb` doit dire `main...origin/main` sans
écart ni fichier modifié, sinon on réaligne d'abord (18/11 : 230 fichiers jamais commités). `~/.claude/hooks/infra-status.sh` est un lien vers ce
dossier : la branche extraite ici pilote le démarrage de toutes les sessions. Sortie : deux écrivains, worktree refusionné aussitôt.

## Déploiement : la prod vient de `main`

`staging` et `main` divergent ; `scripts/pousser-staging.sh` y porte `main` et refuse un conflit. `auto_revert` sur `stack` seul : CI rouge, lire « Groupe en cause ». La CI pose `deploy/hub.nomad.hcl` depuis `main`. La version servie
se lit avec `nomad job inspect hub`, jamais dans le miroir `~/nomad-veridian/jobs/saas-prod/`.
Un audit CVE ou un test rouge saute le déploiement sans bruit : lire `gh run view`, puis l'image.

## Règles

- `hub_user_id` = `users.supabase_user_id`, jamais `users.id` (cuid sur la moitié des comptes).
- Toute route qui mène à une session d'app appelle `denyUnlessEmailProven`
  (`lib/auth/email-proof.ts`). Un test échoue sur toute nouvelle route non gardée.
- `hub reconcile` (`lib/sync/`) n'écrit rien : une dérive se lit et se tranche. Il compare
  aussi les comptes de chaque app au Hub.
- Toute écriture de plan se propage à l'app. Un refus n'écrit rien au Hub.
- Un tenant supprimé n'est jamais repris par une recherche par `userId` (`__tests__/contrat/tenant-supprime.test.ts`).
- Le dépôt est **public**, ses logs Actions aussi : aucune adresse client dans une réponse de cron.

- Les env vars **runtime** viennent du job Nomad (`deploy/hub.nomad.hcl`, secrets `nomad/jobs/hub`), jamais de build-args.
- Stripe = source de vérité billing. Config dans `lib/stripe/`.
- Couleurs : tokens OKLCH. Autre app : son URL publique.
- `/api/health` reste disponible (garde du déploiement et sonde de la CI).

## 💰 Pricing & trial

**Source de vérité** : `docs/PRICING-VERIDIAN.md`, à lire avant de toucher au pricing, à l'essai, à Stripe ou aux limites.
Générosité maximale : tout illimité, seules différences la durée Free 15 j et la marque blanche Business+.
Jamais de limite visible. Stripe → Hub → apps, jamais Stripe → app.

## CI/CD

- `.github/workflows/hub-ci.yml` : test → audit (npm) → docker → **trivy** → deploy-prod (sur `main`) → e2e-prod-smoke → rollback-prod (si fail)
- **Pas de cron Trivy** : CVE de l'image servie via `secu`, `_trivy-image.yml` à la construction.
- Runners GitHub (dépôt public) : le smoke garde `playwright install --with-deps`.
- Logs `nomad-v logs hub`, redeploy `nomad-v run hub`. Skill `/nomad`.

