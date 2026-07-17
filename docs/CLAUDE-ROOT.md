# Veridian — racine polyrepo

> SaaS Veridian. 6 apps polyrepo depuis 2026-05-13. Hub = orchestrateur, les autres apps sont pilotées.

## 🔴 RÈGLE D'OR ABSOLUE — Propre d'abord, zéro contournement (gravée Robert 2026-06-10)

**Le travail se fait PROPREMENT, dans le vrai système, point.** Interdiction
formelle de contourner par peur de toucher la prod, la DB ou les API.

Robert (2026-06-10) : *"ils ont peur de toucher la DB en prod ou les API en
prod, ils passent par des SQLite ou des crons, c'est débile. La règle doit
être de faire ça propre first, tout tester en staging, et quand staging est
parfaitement clean et testé à la main, push en prod avec des tests on-promise
lourds. Aucun contournement ni lâcheté."*

### Le seul workflow autorisé pour TOUT chantier qui touche une DB ou une API

```
1. CODER PROPRE dans le vrai système (la vraie DB, la vraie API, le vrai schéma)
   — PAS de SQLite parallèle, PAS de cron bricolé, PAS de store maison qui
     duplique ce que l'app fait déjà. Le rate-limit d'API natif, les vraies
     tables, les vraies migrations.
2. TESTER sur STAGING (DB staging, API staging — ils EXISTENT pour ça)
3. FIXER les problèmes de LOGIQUE trouvés en staging (c'est là qu'on les voit)
4. METTRE À JOUR la DB de STAGING si nécessaire (migration, seed, fixture) —
   on n'a PAS peur de toucher la DB staging, c'est SON rôle
5. TEST ON-PROMISE LOURD sur staging (E2E réel, à la main, état DB vérifié)
6. Staging parfaitement clean + testé → PUSH PROD (avec tests lourds derrière)
```

### INTERDIT (= lâcheté technique, faute pro)

- ❌ Inventer une SQLite / un store maison parce qu'on "n'ose pas" écrire dans
  la vraie DB. Si ça doit persister, ça persiste dans la vraie DB, staging d'abord.
- ❌ Bricoler un cron / un job parallèle pour éviter de modifier le vrai code.
- ❌ Construire une usine à gaz en marge du système réel. Le code doit être
  **clean et smart, lisible en 5 min**, pas une cathédrale.
- ❌ Contourner un blocage (credential, accès DB/API) en dupliquant la logique.
  On débloque le vrai accès (via le lead), on ne contourne pas.
- ❌ Avoir peur de la DB/API de **staging** : staging existe pour être cassé,
  réparé, recommencé jusqu'à parfait.

### ATTENDU

- ✅ Si bien faire demande de modifier le vrai schéma DB → on le fait (staging,
  migration versionnée).
- ✅ Problème de LOGIQUE → on le RÈGLE, on ne le contourne pas.
- ✅ Avant prod : staging vert, testé à la main, état DB vérifié, E2E lourd.
- ✅ L'agent AVISE s'il voit un problème de conception — mais propose la voie
  propre, jamais le contournement.

**Le team lead est GARANT de ces règles.** Il refuse tout contournement, renvoie
l'agent coder proprement, et débloque les vrais accès au lieu de laisser
inventer une voie de traverse. Husky + CI protègent la prod tant que les tests
passent. SEULE exception sensible : **`veridian-cms`** (sites clients en prod)
— NE PAS Y TOUCHER sans accord explicite de Robert.

## 🔴 OWNERSHIP — l'agent EST propriétaire de son app (gravé Robert 2026-06-10)

**Un agent dédié à une app n'est pas un exécutant timide : c'est le PROPRIÉTAIRE
et le RESPONSABLE de son app.** C'est son identité.

Robert (2026-06-10) : *"Ils ne doivent pas avoir peur de s'approprier un code,
il leur appartient, ils sont responsables. Leur scope est immense : ils peuvent
TOUT toucher ce qui est lié à leur app — de la prod au staging en passant par
l'infra avec les env. C'est ça leur identité. Ils doivent lire autant de
fichiers que nécessaire et les mettre à jour intégralement si nécessaire. Il
faut être radical et franc."*

### Ce que ça veut dire concrètement

- **Le scope d'un agent app = TOUT ce qui est lié à son app** : le code, les
  tests, la **DB prod ET staging**, l'**infra** (jobs Nomad, Traefik,
  containers), les **ENV/secrets** de son app, sa CI, ses runbooks, sa doc.
  Il n'a à demander la permission à personne pour agir dans SON périmètre
  (hors le tier 💀 destructif-irréversible, cf §20 / CI-ARCHITECTURE).
- **Il s'APPROPRIE le code** : il n'a pas peur de reset un password dans sa DB,
  de patcher son job Nomad, de modifier une Variable Nomad, de toucher son schéma,
  de régénérer une API key — c'est SON app, c'est SON job, il est responsable
  du résultat.
- **Il LIT autant de fichiers que nécessaire** : pas de "je suppose", pas de "je
  n'ose pas regarder". Il ouvre le code, les configs, les skills, les docs,
  l'infra — tout ce qu'il faut pour comprendre et agir juste.
- **Il MET À JOUR intégralement** : code + tests + DB + doc + skill + CLAUDE.md
  de son repo. Un changement qui rend une doc/un skill périmé → il corrige la
  doc/le skill dans la foulée. Pas de "je laisse ça pour plus tard".
- **Radical et franc** : il tranche, il agit, il rend compte. Pas de timidité,
  pas de demande de permission sur ce qui est dans son scope, pas de
  contournement par peur. S'il voit un problème → il le dit franchement et le règle.

### La timidité = faute

Un agent qui tergiverse sur une action dans SON périmètre (reset password de SON
CRM, migration de SA DB, patch de SON compose) au lieu de la faire = faute. Le
lead le renvoie agir. La peur de toucher son propre système n'est jamais une
excuse — c'est exactement ce qui produit les contournements débiles
(SQLite/crons parallèles) interdits par la règle d'or ci-dessus.

## Les apps

| Repo | Rôle |
|---|---|
| `veridian-hub` | Auth, billing, provisioning des autres apps |
| `veridian-prospection` | App prospection commerciale |
| `veridian-analytics` | Analytics web pour les sites clients |
| `veridian-cms` | CMS multi-tenant (Payload) pour les sites clients |
| `notifuse-veridian` | Emails transactionnels (fork Notifuse) |
| `veridian-infra` | Compose Docker, runbooks, CI partagée, docs |

## Règle d'or : zéro code partagé (avec UNE exception)

Chaque app a son **propre auth, sa propre DB, son propre billing, son propre deploy**. Pas de package npm commun, pas de workspace monorepo pnpm. Les apps se parlent uniquement via **API HTTP**.

### Exception : `veridian-infra/shared/` via Git submodule (ADR 2026-05-21)

**Une seule exception** : les **constantes business cross-app** qui DOIVENT rester strictement synchronisées entre apps (pricing, types de contrat Hub, refill leads dégressif). Hébergées dans `veridian-infra/shared/` et consommées via **Git submodule** par les apps TS (Hub + Prospection). Notifuse Go ne consomme pas le submodule — il appelle l'endpoint Hub `GET /api/pricing/plans` qui sert le shared en JSON.

**Pourquoi submodule ≠ monorepo** :
- Chaque app reste un **repo Git séparé** (deploy indépendant, CI séparée, history séparée — tout ce qu'on voulait du polyrepo reste vrai)
- Le submodule pointe sur un **SHA précis** de `veridian-infra` — l'app pin la version qu'elle consomme (pas de "dernier main" mouvant)
- Updater le shared = bump du SHA submodule dans l'app + commit (action explicite + audit Git)
- Aucun workspace partagé, aucun `node_modules` mutualisé, aucun build commun
- Si demain on supprime `veridian-infra/shared/`, chaque app garde sa copie figée au SHA pinné — pas de break

**Pourquoi PAS npm package** : 1 fichier qui change 2 fois par an ne mérite pas un cycle build/publish/lockfile dans 3 apps.

**Pourquoi PAS workspace pnpm** : ça casserait l'isolation polyrepo (un seul `pnpm install` à la racine, partage `node_modules`, build couplé).

**Périmètre du shared** (limité par design) :
- ✅ Constantes business cross-app (pricing plans, refill, annual perks)
- ✅ Types de contrats inter-app (HMAC headers, webhook payloads v1.4)
- ❌ Logique applicative (chaque app garde la sienne)
- ❌ UI / composants React (chaque app a sa stack)
- ❌ Utils génériques (pas de tentation de "DRY" cross-repo)

**Process update** :
1. Modifier `veridian-infra/shared/`, commit + push sur `main`
2. Dans chaque app : `git submodule update --remote shared` → bump le SHA pinné
3. Tester localement, commit le nouveau pointer dans l'app, push
4. Notifuse : pas besoin d'action submodule (consomme via API Hub avec cache 1h TTL)

## Interactions actuelles

Aujourd'hui seul le Hub initie des appels. Les autres apps exposent des routes mais n'appellent personne.

- **Hub → Notifuse** : provision tenant, magic link, update/suspend/resume plan
- **Hub → Prospection** : regenerate login
- **OAuth Google + Microsoft sur Hub** (livré 2026-05-20) : Auth.js v5
  providers avec `allowDangerousEmailAccountLinking` activé. Les users
  existants (Credentials/magic link) peuvent se logger via Google ou
  Microsoft sans `OAuthAccountNotLinked`. Mode "Test users" Google avec
  12 users autorisés au Consent Screen `veridian-preprod`. App Registration
  Microsoft multi-tenant créée via `az ad app create` — secrets dans
  `~/credentials/.all-creds.env` + Variables Nomad du job `hub` (`nomad/jobs/hub`).

**OAuth désactivé en staging** : `hub.staging.veridian.site` est derrière
Tailscale (IP privée), déclarer cette redirect URI chez les providers =
red flag réputation. Boutons OAuth gated `DEPLOY_ENV !== 'staging'` dans
`utils/auth-helpers/settings.ts`. Test OAuth = local-dev (`localhost:3000`
déclaré dans Client Google) ou prod direct.

## Règle opérationnelle : APIs pilotées par le Hub

**Seul point de vigilance dev cross-repo.** Si tu modifies une route consommée par le Hub :

1. **Lire le client côté Hub** avant de changer la route (`veridian-hub/lib/<app>/`, `veridian-hub/app/api/<app>/`) — pour voir ce qui est envoyé et attendu.
2. **Maintenir un test contractuel côté app** qui reflète l'usage Hub.
3. **Signaler le breaking change** dans la PR + coordonner la maj côté Hub avant merge.

Une régression silencieuse sur ces routes casse le provisioning et le billing.

## Vision cible — harmonie cross-app

Partiellement implémenté, suite à livrer :

- ✅ **OAuth Sign-in Hub** (Google + Microsoft) : livré 2026-05-20
- ✅ **Magic link cross-app** Hub → Notifuse / Prospection : éprouvé
- ✅ **API admin Hub** (provisioning manuel, mode service) : livré 2026-05-20
- ✅ **Flow invitation centralisé Hub** : livré 2026-05-21 (9/9 étapes,
  endpoints invitation cross-app + UI + email)
- ✅ **Stripe webhook orchestrator + trial state machine** : livré en prod
  sprint v1.4 (2026-05-21). Flow 5 mails → 2j → 15j → downgrade.
- ⏳ **Pattern Discovery cross-app** (`GET /api/users/by-email` au login) :
  spec posée, pas encore câblé côté Hub
- ⏳ **Sync tenants 3 niveaux** (discovery pull + webhook push + cron
  reconcile) : spec posée
- ⏳ **Pricing checkout réel** (Stripe Products/Prices + page billing) :
  giga sprint à venir, voir §"Pricing & trial cross-app" ci-dessous
- ⏳ **Compte Veridian unique** : 1 email → 1 Stripe Customer → N subscriptions

> Le backlog vivant par repo est injecté en début de session (hook
> SessionStart) et agrégé dans `veridian-platform/TODO.md`
> (`./scripts/refresh-todo.sh`). Ne pas maintenir de liste de tickets en
> dur ici — seuls les statuts ✅/⏳ de la vision cible, pas les chemins
> de fichiers qui pourrissent à l'archivage.

Détail des problèmes architecturaux dans `veridian-infra/todo/VISION-CROSS-APP.md`.
Contrats techniques : `CONTRAT-HUB.md` (cross-app), `CONTRAT-BILLING.md`
(billing apps commerciales — extraction en cours, cf ticket Hub
`2026-05-22-extraire-contrat-billing.md`).

## 💰 Pricing & trial cross-app

**Source de vérité unique** : `veridian-hub/docs/PRICING-VERIDIAN.md`.

Tout agent qui touche au pricing, paywall, trial, branding, custom
domains, limites de plan, webhooks Stripe DOIT lire ce fichier avant
d'agir. Il définit :

- La **grille de prix** (Free / Pro 29€ / Business 99€ / Enterprise)
- Le **flow trial complet** (5 mails → 2j silence → 15j visible → +30j
  si CB → débit ou paywall)
- Les **responsabilités cross-app** : Stripe → Hub → apps (PAS Stripe
  → app directement)
- Les **interdits côté code** (pas de mur béton, pas de compteur
  visible, pas de menu grisé)

**Philosophie figée par Robert 2026-05-21** : générosité maximale. Tout
illimité partout. SEULES différenciations = durée Free 15j + white-label
Business+. L'app ne doit JAMAIS être défigurée par des limites visibles.

## 📋 Index TODO cross-app

**Source de vérité unique** : `TODO.md` à la racine `veridian-platform/`.

Index dynamique de **tous les tickets pending + done** de tous les repos
(Hub, Prospection, Analytics, CMS, Notifuse, Infra). Mis à jour via :

```bash
./scripts/refresh-todo.sh
```

À lancer **au début de session** pour voir l'état cross-app du backlog,
et **après archivage d'un ticket** (`mv X/todo/Y.md X/todo/done/`) pour
refléter le changement dans l'index racine.

### Convention `todo/` standardisée cross-repo

Tous les repos suivent ce layout :

```
<repo>/todo/
├── YYYY-MM-DD-<slug>.md     ← ticket pending (à la racine)
├── README.md / SPRINT.md     ← notes thématiques optionnelles
├── done/                     ← archive (tickets résolus, NE PAS SUPPRIMER)
├── blocked/  (optionnel)     ← en attente externe
├── apps/     (optionnel)     ← sous-tickets app-specific (cas Hub)
└── integrations/ (opt.)      ← specs contrats cross-app
```

**Header ticket minimum** (pour que le scanner extraie correctement) :

```markdown
# Titre du ticket

> **Sévérité** : 🔴 P0 / 🟡 P1 / 🟢 P2 / 🔵 P3
> **Owner** : agent <repo>
> **Créé** : YYYY-MM-DD
```

**Archivage d'un ticket résolu** :

```bash
mv <repo>/todo/<ticket>.md <repo>/todo/done/
./scripts/refresh-todo.sh  # depuis racine veridian-platform/
```

## Flow standard : un agent par app

Le workflow par défaut Veridian est **un agent dédié par app** (Hub, Prospection, Analytics, CMS, Notifuse, Infra). En parallèle de toi, il y a généralement d'autres agents qui tournent sur les autres apps, chacun dans son worktree dédié (voir memory [[feedback_worktree_per_agent]]).

**Conséquence concrète** :

- **Ne touche pas au code des autres apps** depuis ton worktree, même si tu vois un fix évident à faire. L'agent dédié de cette app est sûrement en train de travailler dessus et tu créerais un conflit.
- **Si tu as besoin d'une modif côté autre app** (ex : tu bosses sur Hub et tu vois qu'il faut changer un endpoint côté Notifuse) → **demande à Robert de router la demande vers l'agent dédié**. Ne fais pas le fix toi-même.
- **Exception** : modifs purement contractuelles documentées (lecture d'un client API du Hub pour comprendre ce qu'il envoie, vérif d'un schéma) sont OK en lecture seule.

Cette discipline évite les merges sauvages et garde chaque agent autonome sur son périmètre.

### Tickets inter-agents : dossier `todo/` par repo

Chaque repo a un dossier **`todo/`** à sa racine. C'est la **boîte de réception de l'agent dédié de l'app** — un autre agent (ou Robert) peut y déposer un fichier markdown pour demander une modif sans toucher au code lui-même.

**Quand tu as besoin d'une modif chez une autre app** :

1. Crée un fichier dans le `todo/` du repo cible : `veridian-<app>/todo/YYYY-MM-DD-<slug>.md`
2. Format minimal : contexte (pourquoi tu demandes), demande précise (quoi modifier, où), impact côté ton app (ce qui dépend de cette modif), priorité.
3. Prévenir Robert pour qu'il route vers l'agent de l'app cible.
4. **Ne fais pas le fix toi-même** dans le repo voisin, même pour 2 lignes.

**Quand un ticket arrive dans ton `todo/`** :

- Au début de chaque session, vérifie `todo/` — c'est ta file d'attente cross-app.
- Une fois la demande implémentée et mergée, **déplace ou supprime le fichier** pour garder le dossier propre.
- Si la demande est floue ou impossible telle quelle, réponds dans le même fichier (`## Réponse — YYYY-MM-DD`) et préviens Robert.

Robert peut aussi déposer directement des tickets dans n'importe quel `todo/` pour piloter ses agents.

## 🔥 Règle d'or : trunk-based sur `staging` — zéro PR, zéro branche feature

**Tu travailles DIRECT sur `staging`. Tu ne crées PAS de branche feature. Tu n'ouvres PAS de PR.**

Robert est arbitre business, pas reviewer CI. La friction "branche → PR → review → merge" est de la pollution dans notre setup à 1 agent / app + arbitrage humain ponctuel. Le modèle est **trunk-based development** avec deux trunks par app :

- **`staging`** : le trunk de travail. Toutes tes modifs vont ici directement (`git push origin staging`)
- **`main`** : la photo de prod. Reçoit du code via **auto-promotion** depuis staging (jamais via PR humaine)

### Flow standard d'une modif

```
1. git checkout staging
2. git pull origin staging
3. <code, edit, commit>
4. git push origin staging
   → hub-staging.yml deploy auto sur hub.staging.veridian.site
   → smoke staging (healthcheck + Playwright)
5. Smoke staging vert ?
   ✓ OUI → auto-promotion : ff-merge staging → main → push main
            → hub-ci.yml deploy prod + smoke prod
            → rollback auto si smoke prod fail
   ✗ NON → freeze + investigation + fix sur staging (re-push)
```

### Plus jamais de branche feature

**Interdictions absolues :**

- ❌ `git checkout -b feat/<truc>` — interdit
- ❌ `gh pr create` — interdit
- ❌ Cherry-pick entre branches — interdit (sauf rollback d'urgence post-incident)
- ❌ Plusieurs branches qui co-existent à long terme — interdit

**Pourquoi cette discipline** :

1. **Évite les conflits de worktree** entre agents (chaque agent app a son worktree, mais s'il fait du `git checkout` entre des branches qui divergent, il écrase les fichiers non-trackés de l'autre branche → travail perdu). C'est arrivé le 2026-05-17 entre l'agent CI Hub et l'agent Twenty removal.
2. **Élimine la file d'attente PR** : pas de PR ouverte = pas de friction = pas d'oubli
3. **Maintient un trunk court** : 1 SHA staging → 1 SHA main, traçabilité linéaire
4. **Force la qualité immédiate** : pas de "fix dans la PR plus tard", chaque push doit être livrable

### Arbitrage intelligent par l'agent — protocole §20 (Hub)

> ⚠️ **Hub utilise §20 "Promotion graduée par risque"** depuis 2026-05-20
> (cf. `veridian-hub/docs/CI-ARCHITECTURE.md` §20). Les autres apps suivent
> encore le mode "auto-promote inconditionnel" — à migrer dans les semaines
> à venir (cf. §20.10 apps concernées).

Sur **Hub**, chaque commit est classifié par l'agent en 4 tiers :

| Tier | Chemin de promotion |
|---|---|
| 🟢 **BAS** (doc, todo, tests-only, refactor sans surface API) | Marker `[risk:low]` dans le subject → auto-promote CI |
| 🟡 **MOYEN** (UI dashboard, nouvelle route non-auth, bump dep patch) | Agent promote autonome après reco écrite + smoke CI |
| 🔴 **HAUT** (auth, billing, migration, workflow CI, lib partagée) | Agent promote autonome après reco + `pnpm e2e:staging:full` + monitoring 10min post-deploy |
| 💀 **CRITIQUE** (DROP COLUMN, rotation secret prod, suppression tenant) | **Seul tier où l'agent demande explicitement go/stop à Robert** |

Garde-fous techniques :
- Pre-push hook `check-risk-marker.sh` refuse `[risk:low]` si fichier tier 🔴+
- Workflow `hub-staging.yml` job `notify-promotion-needed` notifie Robert via
  Telegram quand staging vert sans `[risk:low]` (= reco agent attendue)
- Outil agent opt-in : `pnpm e2e:staging:full` (Playwright headfull) à dégainer
  selon le risque vu dans le diff

**Veto manager** : Robert peut intervenir à tout moment via mots-clés
`stop` / `rollback` / `freeze` / `unfreeze`. L'agent obtempère sans débat.

Robert intervient explicitement (tier 💀) **uniquement** pour :

- **Migration DB destructive** (DROP COLUMN, ALTER NOT NULL sur rows existantes)
- **Changement de pricing Stripe** ou plan billing (impact tenants existants)
- **Rotation de secret en prod** (downtime potentiel)
- **Suppression de tenant prod actif** ou cleanup massif
- **Refactor du contrat HMAC Hub↔app** ou du flow webhook Stripe

### Cycle complet attendu après chaque push

L'agent **ne quitte pas la session** tant que :

1. **Staging vert** : `gh run watch` sur `hub-staging.yml` jusqu'à conclusion success + `curl https://<app>.staging.veridian.site/api/health` retourne 200
2. **Promotion main exécutée** : `git fetch origin && git checkout main && git merge --ff-only origin/staging && git push origin main`
3. **Prod verte** : `gh run watch` sur `hub-ci.yml` jusqu'à `deploy-prod` + `e2e-prod-smoke` success + `curl https://<app>.veridian.site/api/health` retourne 200
4. **Si rollback déclenché** : confirmer que prod est revenue stable + ouvrir un fix immédiat sur staging
5. **Si CI plante imprévu** : `nomad-v logs <job>` (ou `ssh prod-pub` + `docker logs`) → diagnostic clair à Robert

### 🚨 RÈGLE TEAM LEAD — E2E lourd OBLIGATOIRE avant promo main

**S'applique à tout agent qui orchestre une salve de sous-agents (team lead) ou qui s'apprête à promote staging → main.**

La CI staging actuelle ne lance QUE les tests unitaires Vitest. Les **E2E Playwright** (`e2e/staging-full/*.spec.ts` pour Hub, équivalents pour Prospection/Notifuse) ne tournent **automatiquement nulle part**. Si tu ne les lances pas, tu shippes à l'aveugle même si la CI staging est verte.

**Avant TOUTE promotion vers main, le team lead DOIT** :

1. **Lancer la suite E2E lourde du repo concerné** contre staging réel :
   - Hub : `HEADED=0 STAGING_URL=https://hub.staging.veridian.site pnpm e2e:staging:full` (16 specs dont 4 Stripe, 5-10 min)
   - Prospection : équivalent local (à câbler si pas dispo)
   - Notifuse / CMS / Analytics : idem
2. **Lire les résultats spec par spec**, pas juste "exit code 0"
3. **Pour CHAQUE spec rouge** :
   - Créer un ticket dans `<repo>/todo/YYYY-MM-DD-e2e-fix-<spec-name>.md` avec stack trace + reproduction
   - Spawn un sub-agent Opus dédié (worktree isolé) pour fixer
   - **Bloquer la promo main** tant que toutes les specs ne sont pas vertes
4. **Si nouvelle salve d'agents nécessaire** (plusieurs specs cassées sur des périmètres différents) : lancer **plusieurs sub-agents Opus en parallèle**, un par périmètre, avec consigne stricte "tu fixes UNIQUEMENT la spec X, tu ne touches pas au reste"
5. **Ne promote que quand le E2E lourd repasse vert intégralement**

**Pourquoi cette règle dure** :

- Les tests unitaires Vitest mockent Stripe / les apps downstream / la DB — un mock passant ne garantit rien sur le flow réel
- L'incident 2026-05-23 (staging tournait avec `pk_test_fake/sk_test_fake` au lieu des vraies clés Stripe TEST) prouve que la CI peut être verte alors qu'aucun flow réel ne marche
- Le coût d'un E2E lourd raté en prod = bien plus que les 10 min d'attente du `pnpm e2e:staging:full`

**Pour faciliter cette discipline** :

- Ticket P1 ouvert (`veridian-hub/todo/2026-05-22-ci-e2e-billing-preprod.md`) pour câbler les E2E Stripe en CI automatique → quand ce sera fait, la règle deviendra "fais confiance à la CI E2E", pas "lance à la main"
- Idem pour les autres apps : chaque repo doit câbler son `*-e2e-full.yml` workflow GH Actions, déclenché sur push staging
- En attendant ce câblage, **le team lead lance à la main, point.**

**Sanction** : un push main sans avoir lancé le E2E lourd = faute professionnelle. Si tu provoques un rollback prod parce que tu n'as pas attendu les E2E, tu refais tout le runbook (diagnostic, fix, re-test, re-push, monitoring 30 min) **et tu écris une postmortem** dans `<repo>/todo/POSTMORTEM-YYYY-MM-DD.md`.

### Auto-promotion : où est-elle câblée ?

- ✅ **Hub** : auto-promote câblé dans `hub-staging.yml:promote-to-main` mais
  **gated sur marker `[risk:low]` dans le subject** depuis 2026-05-20 (§20).
  Job `notify-promotion-needed` envoie une notif Telegram à Robert quand
  staging vert sans marker = reco agent attendue.
- ✅ **CMS, Notifuse** : auto-promote câblé (mode inconditionnel pour l'instant).
  À migrer vers §20 quand le trafic réel justifie le durcissement.
- ✅ **Prospection** : pas d'auto-promote (mode "staging-only ship + giga-MAJ"
  cf. CI-ARCHITECTURE §19.2). Promotion manuelle explicite par Robert.
- 🔵 **Analytics** : pas en SaaS public, mode dormant.

Pour les apps tier 🟡 MOYEN et 🔴 HAUT sur Hub : promotion **par l'agent** via
`git merge --ff-only origin/staging && git push origin main` après reco
écrite. L'agent reste sur le mode trunk-based — pas de branche feature.

### Pré-requis CI pour autoriser ce mode (par app)

(Hub : tout en règle au 2026-05-17. Autres apps à aligner — voir `veridian-hub/.github/workflows/hub-ci.yml` comme référence pixel-parfaite)

- ✅ `hub-staging.yml` deploy auto sur push branche `staging`
- ✅ `hub-ci.yml` étage 3 deploy-prod + e2e-prod-smoke + rollback-prod automatique
- ✅ `structural-gate` qui exige staging vert ≤24h si fichiers structurels modifiés
- ✅ Healthcheck `/api/health` qui répond 200 (gate Docker + smoke CI)
- ✅ Tag `:rollback` automatiquement posé avant chaque deploy

Si une de ces couches manque sur ton app, **tu la câbles AVANT de bosser en mode trunk staging**. Pas de raccourci.

### Sanction de l'inaction

- Une branche feature créée par toi = faute professionnelle. Tu reset, tu replay sur staging.
- Une PR ouverte > 5 minutes = faute. Tu merges si vert ou tu rebases sur staging si tu changes d'approche.
- Du travail perdu à cause d'un `git checkout` qui écrase les fichiers d'un autre agent = double faute (toi + ton process). On ne `checkout` jamais une branche divergente sans avoir d'abord `git stash` ou commit ce qui traîne.

---

## Staging — dev server dédié

Le **dev server OVH** (`ssh dev-pub`, IP `37.187.199.185`) est entièrement disponible comme environnement de staging pour les agents. Plus de Dokploy dessus depuis 2026-05-14 : reverse proxy Traefik standalone, chaque app déploie sa propre stack docker compose.

### Ce que chaque app doit faire

1. **Avoir une branche `staging`** dans son repo (parallèle à `main`).
2. **CI branchée sur `staging`** : à chaque push, le workflow SSH dans `dev-pub` (clé `github-actions-deploy` déjà dans `authorized_keys`), pull le repo, lance `docker compose up -d` dans son dossier dédié sur dev.
3. **Compose staging dédié** (`docker-compose.staging.yml` ou `docker-compose.dev.yml`) qui joint le réseau externe `staging-edge` et expose l'app via labels Traefik sur `<app>.staging.veridian.site` (cert Let's Encrypt auto via ACME DNS-01).

### Convention de routage

| App | URL staging |
|---|---|
| Hub | `hub.staging.veridian.site` |
| Prospection | `prospection.staging.veridian.site` |
| Analytics | `analytics.staging.veridian.site` |
| CMS | `cms.staging.veridian.site` |
| Notifuse | `notifuse.staging.veridian.site` |

DNS wildcard `*.staging.veridian.site → 37.187.199.185` déjà actif côté Cloudflare. Aucune action DNS à faire par app.

### Pattern compose staging

```yaml
services:
  app:
    image: ghcr.io/christ-roy/<app>:staging
    networks:
      - staging-edge
      - default
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=staging-edge"
      - "traefik.http.routers.<app>.rule=Host(`<app>.staging.veridian.site`)"
      - "traefik.http.routers.<app>.entrypoints=websecure"
      - "traefik.http.routers.<app>.tls.certresolver=letsencrypt"
      - "traefik.http.services.<app>.loadbalancer.server.port=3000"

networks:
  staging-edge:
    external: true
  default:
```

### Config Traefik

Sur `dev-pub` : `~/traefik-staging/` (README inclus). Service systemd `traefik-staging.service` enabled. Token CF ACME : `CF_DNS_TOKEN_TRAEFIK_DEV` dans `~/credentials/.all-creds.env` (scope DNS:Edit + Zone:Read sur veridian.site uniquement, IP allowlist dev only).

### Règles d'usage

- **Ne pas pousser en prod depuis dev** : le dev server ne sert qu'aux tests staging, pas de bridge vers prod.
- **Pas de DB partagée avec prod** : chaque app utilise sa propre DB staging (clone prod possible ponctuellement pour tests, sinon seed/fixtures).
- **Pas de Dokploy sur dev** : si tu vois une procédure qui dit "déployer le compose Dokploy sur dev server", c'est obsolète depuis 2026-05-14. Le compose est dans le repo de l'app, le CI le déploie.
- **Resources** : dev = 7.6G RAM / 72G disk. Si tu satures, dégrade le profil (mode singleton, pas de replicas, builds sur runner self-hosted plutôt qu'en local).

## Nomad — orchestration de TOUT ce qui tourne (prod, staging, démos, infra)

> **Dokploy est DÉCOMMISSIONNÉ (2026-07-10).** Toute la prod SaaS, le staging, les démos e-commerce
> Medusa et l'infra (ingress Traefik HA, Sablier, Patroni) tournent sur un **cluster HashiCorp Nomad**
> (control-plane sur le bastion Contabo, + nœud résidentiel `mail`). Oublie l'API Dokploy et les
> `composeId` — ils n'existent plus.

### Le CLI `nomad-v` — LA source de vérité
`~/bin/nomad-v` (dans le PATH) est le wrapper Veridian du cluster. Il charge tout seul `NOMAD_ADDR`/
`NOMAD_TOKEN` depuis `~/credentials/nomad-bastion.env`. **Tout passe par lui** (jamais `nomad job` brut
pour muter). Commandes clés :

| Action | Commande |
|---|---|
| Où on en est (dashboard live) | `nomad-v state` |
| Jobs groupés par tier | `nomad-v tiers` |
| Compute libre par nœud (réservé vs réel) | `nomad-v free` |
| Drift IaC (job non versionné/non commité) | `nomad-v drift` |
| Logs d'un job / shell dans un container | `nomad-v logs <job>` / `nomad-v exec <alloc>` |
| Déployer / redéployer | `nomad-v deploy <fichier>` / `nomad-v run <job>` |
| Workloads batch ODH (scraping) | `nomad-v odh template|validate|plan|submit` |

### Garde-fous (n'importe quel agent bosse sans casser la prod)
`nomad-v deploy`/`run` **refusent** un job non commité ou sans `resources`/`datacenters`, affichent une
checklist, et **confirment** stop/purge (double barrière sur les jobs critiques ingress/DB). Après tout
déploiement : `nomad-v drift` doit être à exit 0. Règles complètes : **skill `/nomad`** (encadré "GARDE-FOUS").

### IaC — jobs versionnés
Tout job vit dans **`~/nomad-veridian/`** (`jobs/<tier>/` : saas-prod, saas-staging, medusa-demo, internal,
infra ; runbooks, tickets, configs des nœuds), poussé sur **github.com/Christ-Roy/nomad-veridian**. Un agent
qui touche l'infra lit ce repo et charge `/nomad`.

### Scale-to-zero (Sablier)
Le job `sablier` (fork maison + provider Nomad écrit par nous + plugin Traefik sur les 2 ingress) endort
les démos/staging web inactifs et les réveille sur requête HTTP (page d'attente Veridian). NE PAS confondre
avec l'orchestration batch ODH (`nomad-v odh`, scheduler préemptible multi-nœud).

### Debug / actions
`nomad-v logs <job>` ou `nomad-v exec <alloc> /bin/sh` (plus d'API Dokploy, plus de `ssh prod-pub 'docker logs'`).
État : `nomad-v state`. Actions destructives (purge, rollback prod) : confirmer avec Robert.

## Outils CLI installés sur la machine locale (2026-05-20)

- `gcloud` (Google Cloud SDK 541.0.0) — projet actif `veridian-preprod`,
  loggué `brunon5robert@gmail.com`. ⚠️ **Les IAP OAuth Admin APIs sont
  dépréciées par Google depuis fin 2025 et shutdown 2026-03-19** : pas de
  CLI pour modifier OAuth Consent Screen ou Client IDs. Passer par
  `console.cloud.google.com/auth/*` via Chrome.
- `az` (Azure CLI 2.86.0, installé via `pip3 install --user azure-cli`) —
  loggué `robert.brunon@veridian.site`, tenant Entra
  `fb247439-edf2-46d4-8691-4965a2e3bcf8`. Permet `az ad app create/update`
  pour App Registrations Microsoft Entra.
- `gh` (GitHub CLI) — accès `Christ-Roy/*`
- `pnpm` (10.x) sur Hub
- Chrome MCP (extension claude-in-chrome) — disponible pour piloter Chrome
  réel quand l'API CLI n'existe pas (cas Google OAuth Consent Screen).
