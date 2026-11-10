# Hub SaaS Veridian

> ## 🔴 Règle d'or Veridian — zéro contournement (gravée Robert 2026-06-10)
> **Interdit absolu** : cron bricolé, SQLite/store parallèle, job maison pour
> ÉVITER l'API ou la DB réelle de l'app. On travaille AVEC le vrai système :
> coder propre → tester staging → fixer la logique → MAJ DB staging si besoin
> → test lourd → push prod. Un blocage (accès, credential) se débloque via le
> lead, il ne se contourne pas. Détail : CLAUDE.md racine veridian-platform.


> Application orchestratrice du SaaS.

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

## Structure

```
app/ (auth, marketing, dashboard, admin, api)   auth.ts, auth.config.ts (edge), middleware.ts
lib/ auth admin prisma notifuse stripe mcp (porte MCP) apps (deprovision, lier-hub) sync (reconcile)
prisma/ (schema, migrations)   utils/tenants/provision.ts   utils/stripe/prisma-sync.ts   styles/main.css (OKLCH)
```

## Session et identité

Le Hub est la seule source des utilisateurs des apps. Contrat : `docs/CONTRAT-HUB.md` §3.8 et §6bis.8.0.

- **Session d'un an, glissante.** La révocation se lit en base dans le callback `jwt` de `auth.ts`,
  sur `authAt`. Jamais sur `iat` : Auth.js le réécrit à chaque lecture, middleware compris (faille
  mesurée en prod le 07/11).
- **Preuve récente** : `lib/auth/recent-auth.ts` (24 h compte et admin, 7 j facturation).
- **Rebond** : `api/auth/bounce/prepare` et `complete`. Anti-boucle par app, sur 30 s, jamais remis à
  zéro sur `complete`. Aucun lien hors d'une adresse prouvée.
- **Batterie** : `pnpm test:systeme`, à jouer depuis le bastion, sur ce qui est servi. Twenty :
  `HUB_URL=https://hub.staging.veridian.site`. Après une modification, rejouer chaque
  `SSO_SABOTAGE=<scénario>` : il doit échouer. Elle retire ses comptes, et échoue s'il en reste.
- **Rebond refusé** : jamais muet (08/11, Robert renvoyé sans un mot). Tout refus va sur `/auth/bounce/error` qui
  l'explique (`user_not_in_app`, `hub_user_conflict` : un compte d'app n'appartient qu'au premier compte Hub relié),
  et laisse `[bounce][refus]` (app, code, hub_user_id, jamais l'adresse). Batterie : `09-adresses` ; `10-creation`
  (OAuth jusqu'au fournisseur ; inscription pendant un déploiement : `SSO_PENDANT_DEPLOIEMENT=1 … 10-` après un push).
- **Variables du job** : toute variable lue par le code est rendue par `deploy/hub.nomad.hcl` (source de la CI) ou
  déclarée facultative avec sa raison (`__tests__/contrat/variables-job.test.ts`). 08/11 : `MICROSOFT_OAUTH_*` manquait,
  `client_id=undefined`. Une clé de `nomad/jobs/hub` se pose AVANT le déploiement qui la rend.
- **Essai** : le 5e mail Notifuse nourrit `tenant_trials` ; le tick (30 min) n'active qu'à 48 h. Drapeau
  `TRIAL_MACHINE_ENABLED` (`lib/trial/flag.ts`) rendu par le template depuis `nomad/jobs/hub` : absent = 1, seul `0` coupe.
  **Couper** : clé à 0, bloc complet par stdin (`nomad var put -out none -in json -check-index <index> nomad/jobs/hub -`,
  index via `nomad-v raw var list nomad/jobs/hub`), puis `nomad-v run hub`. Preuve : `__tests__/lib/trial/flag.test.ts`.
- **Plans d'Analytics et du CRM** : posés par `hub plan --app analytics|crm`, l'activation et Stripe
  (`lib/plans/app-plan.ts`), avec le statut d'essai (`lib/plans/trial-status.ts`). Les apps stockent, aucune
  limite ni lecture seule (drapeau coupé, décision de Robert). Ce qui manque : `hub reconcile --ecarts`.
- **Porte MCP** (09/11, `docs/CONTRAT-MCP.md`) : `/api/mcp`, 3 outils pour toutes les apps. Le Hub est serveur OAuth
  et registre (`hub mcp-app add`), ne code aucun outil d'app, présente à l'app un JWT ES256 (`MCP_SIGNING_JWK`).
  `tenant_id` signé seulement si l'IA choisit un espace ; espace non relié → `hub relier --app <app>`. Boutons
  « Ajouter à Claude… » : `/dashboard/ia` au Hub, et dans chaque app par `GET /api/mcp/liens-installation?app=<cle>`
  (public ; une origine de lien nouvelle s'annonce aux apps, Twenty les filtre).
- **Garde rapide** : `__tests__/contrat/` (revocation sans `iat`, `authAt` sur toute création de session,
  cibles du rebond, origines). Un nouveau `encode(` de JWT de session s'ajoute à sa liste. Détail par
  parcours et état prouvé ou accepté : `docs/PARCOURS-IDENTITE.md`.
- **Sonde de prod** : étape « Sonde identité » de `hub-ci.yml` (lectures seules). Le cron de reconcile
  alerte au-dessus de `RESIDUE_SEUIL` (0 par défaut).
- **Coupure** : aucune (08/11, prouvé à la sonde). Base sur pg-saas (grappe Patroni, hors du job Hub), app en bleu-vert : canari,
  health check Traefik, retry. Tags Traefik changés = déploiement annoncé (deux versions aux tags différents : 12 s de 404).
  Regrouper les changements. `e2e/systeme-sso/**` ne redéploie rien.

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
  puis purge des DNAT orphelins). Un déploiement coupe 19 à 51 s (07/11) : attendre `/api/health` avant de conclure.
- **Couper un compte en urgence** : `hub app-access <email> --app twenty|analytics|cms --enabled false`, `hub unlink <email> --app <app>`
  ou `hub delete-tenant <email> --confirm` (irréversible, propage aux apps). Pas de commande admin « révoquer les sessions
  seulement » : le client le fait depuis Réglages > Sécurité ; sinon `AUTH_SECRET`.
- **Cookie volé suspecté** : le client « se déconnecte partout » (coupe Hub et apps, la réponse nomme les apps en échec) ;
  changer son mot de passe fait pareil. Un cookie simplement déconnecté reste valable jusqu'à expiration.
- **`AUTH_SECRET` à changer** : coupe TOUTES les sessions du Hub et les rebonds en cours ; ne coupe pas les sessions
  déjà ouvertes dans les apps. Secret dans la Nomad Variable `nomad/jobs/hub` : lire une clé avec
  `nomad-v raw var get -item AUTH_SECRET nomad/jobs/hub`, écrire avec `nomad var put -out none -in json nomad/jobs/hub -`
  (remplace le bloc entier : repartir du JSON complet), puis `nomad-v run hub`. Compter une reconnexion générale.
- **Restes de test** : `hub reconcile` (`testResidue.total`) et, par app, `scripts/orphelins-e2e.sh` (skill hub-admin).
  `delete-tenant` déprovisionne les espaces des apps (`lib/apps/deprovision.ts`) et laisse une trace d'audit.
  Le cron alerte au-dessus de `RESIDUE_SEUIL`. La batterie les retire elle-même et échoue s'il en reste.
- **Batterie rouge** : lire `e2e/systeme-sso/.run/resultat.txt`. ÉCHOUE = vrai défaut (si l'image servie n'est pas
  listée « avant »). NON ABOUTI = on n'a pas mesuré (Hub en déploiement, jeton Nomad, compte non créé). Relancer
  un filtre : `bash scripts/test-systeme-sso.sh 08-`. Épreuve : `SSO_SABOTAGE=<scénario>` doit échouer.
- **Jeton Nomad 403** : une rotation a révoqué celui du shell. `nomad-v` relit `~/credentials/nomad-bastion.env` ;
  `nomad-v acl status` montre les jetons et leurs échéances. Ne jamais se replier sur le jeton management.

## Commandes

`pnpm install` · `pnpm dev` (port 3000) · `pnpm build` · `pnpm test` (Vitest, 3000+ tests).

## Déploiement : la prod vient de `main`

`staging` et `main` divergent. La CI pose `deploy/hub.nomad.hcl` depuis `main`. La version servie
se lit avec `nomad job inspect hub`, jamais dans le miroir `~/nomad-veridian/jobs/saas-prod/`.
Un audit CVE ou un test rouge saute le déploiement sans bruit : lire `gh run view`, puis l'image.

## Provisioning flow

Signup → `utils/tenants/provision.ts` → Notifuse et Prospection en parallèle → `Tenant`.

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
- Couleurs : tokens OKLCH seulement. Autre app : son URL publique.
- `/api/health` reste disponible (garde du déploiement et sonde de la CI).

## 💰 Pricing & trial

**Source de vérité** : `docs/PRICING-VERIDIAN.md`, à lire avant de toucher au pricing, à l'essai, à Stripe ou aux limites.
Générosité maximale : tout illimité, seules différences la durée Free 15 j et la marque blanche Business+.
Jamais de limite visible. Stripe → Hub → apps, jamais Stripe → app.

## CI/CD

- `.github/workflows/hub-ci.yml` : test → audit (npm) → docker → **trivy** → deploy-prod (sur `main`) → e2e-prod-smoke → rollback-prod (si fail)
- **Pas de cron Trivy** (il scannait `:latest`) : CVE de l'image en cours via `secu` ; `_trivy-image.yml` à la construction.
- Runners hébergés par GitHub (dépôt public) : le smoke garde `playwright install --with-deps`.
- Déploiement : job Nomad. Logs `nomad-v logs hub`, redeploy `nomad-v run hub`, état `nomad-v state`.
  Secrets = Nomad Variable `nomad/jobs/hub`. Skill `/nomad`.

