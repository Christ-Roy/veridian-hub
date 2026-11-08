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

> Supabase retiré du Hub (migration Auth.js v5 + Prisma le 2026-05-08).

## Stack

- Next.js 15 (App Router) + pnpm
- Auth.js v5 (Google OAuth + Credentials bcrypt + MFA email)
- Prisma 7 sur Postgres dédié `veridian-core-db` (schema `hub_app`)
- Stripe (billing, webhooks, plans)
- shadcn/ui + Tailwind
- Brevo pour les mails transactionnels (`lib/email/send.ts`), Notifuse fork pour les tenants

## Structure

```
hub/
├── app/                    # Pages (auth, marketing, dashboard, admin, api)
│   ├── (auth)/ (marketing)/ dashboard/ invite/[token]/
│   └── api/                # routes API, webhooks Stripe + Notifuse
├── auth.ts                 # Auth.js v5 config (providers + callbacks + MFA)
├── auth.config.ts          # Config edge-safe (middleware)
├── middleware.ts           # NextAuth middleware
├── components/             # React components
├── lib/
│   ├── auth/               # getCurrentUser, requireUser, userUuid helpers
│   ├── admin/              # check-admin, is-platform-admin
│   ├── prisma/             # Prisma client singleton lazy proxy
│   ├── notifuse/           # NotifuseClient (Hub → Notifuse fork API)
│   ├── stripe/             # Stripe SDK + plans
│   └── mfa/ email/templates/
├── prisma/
│   ├── schema.prisma       # 15 modèles (User, Workspace, Tenant, Subscription...)
│   └── migrations/         # Migrations Prisma
├── utils/
│   ├── tenants/provision.ts  # Provisioning Notifuse + Prospection
│   ├── stripe/prisma-sync.ts # Sync Stripe → Prisma (Product, Price, Subscription)
│   ├── auth-helpers/       # Helpers session
│   └── env.ts, fetch.ts, helpers.ts
├── styles/main.css         # Theme OKLCH (jamais hardcoder les couleurs)
└── Dockerfile              # Multi-stage Node 20-alpine (deps → builder → runner)
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
- **Microsoft (08/11)** : l'application Entra refuse les comptes personnels (`unauthorized_client`), celui de Robert
  compris. En attente du réglage d'audience par Robert dans Azure ; le cas OAuth Microsoft de `10-` reste rouge d'ici là.
- **Restes de test** : `testResidue` de `hub reconcile`.
- **Garde rapide** : `__tests__/contrat/` (revocation sans `iat`, `authAt` sur toute création de session,
  cibles du rebond, origines). Un nouveau `encode(` de JWT de session s'ajoute à sa liste. Détail par
  parcours et état prouvé ou accepté : `docs/PARCOURS-IDENTITE.md`.
- **Sonde de prod** : étape « Sonde identité » de `hub-ci.yml` (lectures seules). Le cron de reconcile
  alerte au-dessus de `RESIDUE_SEUIL` (0 par défaut).
- **Coupure** : aucune (08/11, prouvé à la sonde). Base dans le job `hub-db` (nomad-veridian), app en bleu-vert : canari,
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
- **Restes de test** : `hub reconcile` (`testResidue.total`, 5 connus au 07/11), retrait `hub delete-tenant <email> --confirm`.
  Le cron alerte au-dessus de `RESIDUE_SEUIL`. La batterie les retire elle-même et échoue s'il en reste.
- **Batterie rouge** : lire `e2e/systeme-sso/.run/resultat.txt`. ÉCHOUE = vrai défaut (si l'image servie n'est pas
  listée « avant »). NON ABOUTI = on n'a pas mesuré (Hub en déploiement, jeton Nomad, compte non créé). Relancer
  un filtre : `bash scripts/test-systeme-sso.sh 08-`. Épreuve : `SSO_SABOTAGE=<scénario>` doit échouer.
- **Jeton Nomad 403** : une rotation a révoqué celui du shell. `nomad-v` relit `~/credentials/nomad-bastion.env` ;
  `nomad-v acl status` montre les jetons et leurs échéances. Ne jamais se replier sur le jeton management.

## Commandes

`pnpm install` · `pnpm dev` (port 3000) · `pnpm build` · `pnpm test` (Vitest, 3000+ tests).

## Identité (décision Robert, 06/11/2026)

Le Hub est la **seule source de vérité des utilisateurs**, chaque app garde sa base et une
copie de ses comptes, sans inscription ni mot de passe utilisable.
Référence : `docs/CONTRAT-HUB.md` §3.7, §3.8, `docs/SAAS-STANDARDS.md` §1.1, §1.2.

- `hub_user_id` = `users.supabase_user_id`, jamais `users.id` (cuid sur la moitié des comptes).
- Toute route qui mène à une session d'app appelle `denyUnlessEmailProven`
  (`lib/auth/email-proof.ts`). Un test échoue sur toute nouvelle route non gardée.
- `hub reconcile` (`lib/sync/`) n'écrit rien : une dérive se lit et se tranche. Il compare
  aussi les comptes de chaque app au Hub.
- Toute écriture de plan se propage à l'app. Un refus n'écrit rien au Hub.
- Le dépôt est **public**, ses logs Actions aussi : aucune adresse client dans une réponse de cron.

## Déploiement : la prod vient de `main`

`staging` et `main` divergent. La CI pose `deploy/hub.nomad.hcl` depuis `main`. La version servie
se lit avec `nomad job inspect hub`, jamais dans le miroir `~/nomad-veridian/jobs/saas-prod/`.
Un audit CVE ou un test rouge saute le déploiement sans bruit : lire `gh run view`, puis l'image.

## Provisioning flow

Signup (Auth.js) → `/api/auth/signup` → `utils/tenants/provision.ts` → Notifuse et Prospection (REST, en
parallèle) → table `Tenant`. `User.supabaseUserId` est un nom legacy : l'UUID de pont (`hub_user_id`).

## Règles

- Les env vars **runtime** sont injectées via docker-compose (pas de build-args).
  Le compose Git de référence : `infra/services/hub/docker-compose.yml`.
- Stripe = source de vérité billing. Config dans `lib/stripe/`.
- Ne jamais hardcoder les couleurs — utiliser les design tokens CSS (OKLCH).
- Les migrations DB sont dans `hub/prisma/migrations/` (Prisma, pas Supabase).
- Pour appeler une autre app du monorepo, utiliser **toujours l'URL publique**
  `https://<app>.app.veridian.site` (cf `07-inter-app-communication.md`).
- Healthcheck `/api/health` doit rester disponible (gate Docker + smoke CI/CD).

## 💰 Pricing & trial

**Source de vérité unique** : `docs/PRICING-VERIDIAN.md` (figé par
Robert 2026-05-21, voir aussi le `CLAUDE.md` racine `../CLAUDE.md`
§"Pricing & trial cross-app").

Tout agent qui touche au pricing, paywall, trial, billing Stripe,
branding, custom domains, limites de plan, webhooks downstream
**DOIT lire ce fichier avant d'agir**. Il définit :

- La **grille de prix** (Free / Pro 29€ / Business 99€ / Enterprise)
- Le **flow trial complet** (5 mails → 2j silence → 15j visible →
  +30j inconditionnel si CB → débit auto ou paywall lecture seule)
- Les **responsabilités cross-app** : Stripe → Hub → apps (PAS
  Stripe → app directement)
- Les **interdits côté code** (pas de mur béton, pas de compteur
  visible, pas de menu grisé)

**Philosophie figée** : générosité maximale. Tout illimité partout.
SEULES différenciations = durée Free 15j + white-label Business+.
L'app ne doit JAMAIS être défigurée par des limites visibles.

Backlog pricing/trial : injecté au démarrage (hook SessionStart), `veridian-platform/TODO.md` pour la vue
cross-app, avancement dans `docs/PRICING-VERIDIAN.md` §"Implémentations actuelles — Hub".

## CI/CD

- `.github/workflows/hub-ci.yml` : test → audit (npm) → docker → **trivy** → deploy-prod (sur `main`) → e2e-prod-smoke → rollback-prod (si fail)
- **Pas de cron Trivy** (`hub-security-cron.yml` retiré le 2026-09-23 : il scannait `:latest`, pas
  l'image déployée). Les CVE de l'image en cours : `sec-scan` via le CLI `secu`. `_trivy-image.yml`
  reste le scan à la construction.
- Déploiement : **job Nomad** (Dokploy décommissionné 2026-07-10). Job HCL
  versionné dans `~/nomad-veridian/jobs/saas-prod/` (staging dans `saas-staging/`).
  Debug/logs `nomad-v logs hub`, redeploy `nomad-v run hub` / `nomad-v deploy <fichier>`,
  état `nomad-v state`. Secrets = Nomad Variable `nomad/jobs/hub`. Skill `/nomad`.

Cf `runbooks/services/hub/deploy.md` pour les détails opérationnels.
