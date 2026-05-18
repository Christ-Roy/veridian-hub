# Veridian — racine polyrepo

> SaaS Veridian. 6 apps polyrepo depuis 2026-05-13. Hub = orchestrateur, les autres apps sont pilotées.

## Les apps

| Repo | Rôle |
|---|---|
| `veridian-hub` | Auth, billing, provisioning des autres apps |
| `veridian-prospection` | App prospection commerciale |
| `veridian-analytics` | Analytics web pour les sites clients |
| `veridian-cms` | CMS multi-tenant (Payload) pour les sites clients |
| `notifuse-veridian` | Emails transactionnels (fork Notifuse) |
| `veridian-infra` | Compose Docker, runbooks, CI partagée, docs |

## Règle d'or : zéro code partagé

Chaque app a son **propre auth, sa propre DB, son propre billing, son propre deploy**. Pas de package commun, pas de workspace monorepo. Les apps se parlent uniquement via **API HTTP**.

## Interactions actuelles

Aujourd'hui seul le Hub initie des appels. Les autres apps exposent des routes mais n'appellent personne.

- **Hub → Notifuse** : provision tenant, magic link, update/suspend/resume plan
- **Hub → Prospection** : regenerate login

## Règle opérationnelle : APIs pilotées par le Hub

**Seul point de vigilance dev cross-repo.** Si tu modifies une route consommée par le Hub :

1. **Lire le client côté Hub** avant de changer la route (`veridian-hub/lib/<app>/`, `veridian-hub/app/api/<app>/`) — pour voir ce qui est envoyé et attendu.
2. **Maintenir un test contractuel côté app** qui reflète l'usage Hub.
3. **Signaler le breaking change** dans la PR + coordonner la maj côté Hub avant merge.

Une régression silencieuse sur ces routes casse le provisioning et le billing.

## Vision cible — Hub comme SSO central

Pas encore implémenté, à venir :

- **SSO** : auth unique sur Hub, sessions propagées vers les apps
- **Magic link cross-app** (style Prospection, session 9 mois)
- **Workspace admin Robert** : vue cross-tenant + actions self-service (envoyer magic link, rotate key, suspend, etc.) sans passer par Claude
- **Stripe trial intelligent** : 1 trial par app, non re-démarrable, source de vérité côté Hub
- **Compte Veridian unique** : 1 email → 1 Stripe Customer → N subscriptions par app

Détail des problèmes architecturaux dans `veridian-infra/todo/VISION-CROSS-APP.md`.

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

### Arbitrage intelligent par l'agent

L'agent arbitre tout seul **sans demander à Robert** :

| Situation | Action agent |
|---|---|
| Smoke staging vert + diff = code applicatif normal | Auto-promote staging → main |
| Smoke staging vert + diff = workflow CI / Dockerfile / migration | Auto-promote staging → main (le `structural-gate` côté main validera que staging est récent) |
| Smoke staging fail | Freeze, investiguer (logs Traefik dev, logs container staging via SSH), fix sur staging, re-push |
| Smoke prod fail post-deploy | Le `rollback-prod` automatique repush `:rollback`. Agent investigue la cause root, fix sur staging, re-cycle |
| Plusieurs agents pushent sur staging en même temps | Le second voit `git push` rejected (non-fast-forward) → `git pull --rebase` + retry. Pas de force-push |

Robert intervient SEULEMENT pour :

- **Migration DB destructive** (DROP COLUMN, ALTER NOT NULL sur rows existantes) → même si `@safe` ack côté script, l'agent demande
- **Changement de pricing Stripe** ou plan billing (impact tenants existants)
- **Rotation de secret en prod** (downtime potentiel)
- **Suppression de tenant prod actif** ou cleanup massif
- **Feature qui change l'UX** des tenants existants

### Cycle complet attendu après chaque push

L'agent **ne quitte pas la session** tant que :

1. **Staging vert** : `gh run watch` sur `hub-staging.yml` jusqu'à conclusion success + `curl https://<app>.staging.veridian.site/api/health` retourne 200
2. **Promotion main exécutée** : `git fetch origin && git checkout main && git merge --ff-only origin/staging && git push origin main`
3. **Prod verte** : `gh run watch` sur `hub-ci.yml` jusqu'à `deploy-prod` + `e2e-prod-smoke` success + `curl https://<app>.veridian.site/api/health` retourne 200
4. **Si rollback déclenché** : confirmer que prod est revenue stable + ouvrir un fix immédiat sur staging
5. **Si CI plante imprévu** : `ssh prod-pub` + `docker logs` ou Dokploy API `docker.getContainerLogs` → diagnostic clair à Robert

### Auto-promotion : où est-elle câblée ?

Pas encore. À implémenter par chaque app :

- Workflow `hub-staging.yml` (ou équivalent) : ajouter un job final `promote-to-main` `if: success()` qui fait :
  ```bash
  gh api -X POST /repos/Christ-Roy/<repo>/merges \
    -F base=main -F head=staging \
    -f commit_message="auto-promote: $(git log -1 --format=%s)"
  ```
  ou équivalent via `git push` avec credentials repo.
- Ou : check côté `hub-ci.yml` qui s'auto-déclenche sur staging vert via `repository_dispatch`

**Tant que l'auto-promotion n'est pas câblée**, l'agent fait la promotion manuellement (étape 2 ci-dessus) — mais reste sur le mode trunk-based pas de branche feature.

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

## Dokploy — accès API pour les agents (prod uniquement)

Dokploy orchestre les containers de **production** Veridian. **Tu peux interagir directement via l'API REST** pour debug, redéployer, lire des logs, inspecter un compose, sans passer par l'UI.

### Endpoints

- **API publique** : `https://dokploy.veridian.site/api/*` — accessible depuis n'importe où en HTTPS
- **Token** : `$DOKPLOY_API_KEY` dans `~/credentials/.all-creds.env` (header `x-api-key`)
- **UI** : `https://dokploy.veridian.site` (même mot de passe que les autres dashboards Veridian)

### Ce que tu peux faire sans passer par Robert

| Action | Endpoint | Usage |
|---|---|---|
| Lister tous les composes | `GET /api/compose.all` | Voir l'état de la stack |
| Détail d'un compose | `GET /api/compose.one?composeId=<id>` | Lire env, domains, source type |
| Lire les logs | `GET /api/docker.getContainerLogs?containerId=<id>&lines=200` | Debug sans SSH |
| Redéployer un compose | `POST /api/compose.deploy` body `{composeId}` | Force redeploy après modif |
| Modifier un compose | `POST /api/compose.update` body `{composeId, ...fields}` | ENV, domaines, source type |
| Lister les domaines | `GET /api/domain.byComposeId?composeId=<id>` | Voir les routes Traefik injectées |
| Supprimer un domaine | `POST /api/domain.delete` body `{domainId}` | Fix dual-router Traefik |
| Status containers | `GET /api/docker.getContainers` | Liste tous les containers + state |

### Convention d'usage

- **Pour debug d'un container qui plante** : `docker.getContainerLogs` plutôt que `ssh prod-pub 'docker logs'` — plus rapide, scriptable, pas de quote-hell
- **Pour redéployer après bump deps/CVE** : `compose.deploy` direct, pas besoin de toucher à l'UI
- **Pour modifier un compose en mode GitOps** : `compose.update` puis `compose.deploy` — voir [[session_2026-05-13_notifuse_gitops_extraction]] pour les pièges (manifest digest vs `.Image`, Domains injectent labels Traefik = dual-router, etc.)
- **Pour les actions destructives** (suppression compose, rollback prod) : confirmer avec Robert avant
- **Tous les `composeId` documentés** dans les memories sessions correspondantes

Liens utiles dans memory : [[project_dokploy_improvements]], [[project_dokploy_gitops_migration]], [[project_infra_pieges]].
