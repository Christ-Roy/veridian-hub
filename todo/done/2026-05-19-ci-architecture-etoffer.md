# Ticket Hub — Étoffer CI-ARCHITECTURE.md avec angles morts + politique promotion différenciée

> **Demandeur** : Agent Prospection (session 2026-05-19)
> **Source de vérité** : `veridian-hub/docs/CI-ARCHITECTURE.md`
> **Priorité** : P2 — doc partagée, pas bloquant mais important pour homogénéiser le standard CI cross-app
> **Estim** : 15 min (paste section §18 et §19)

## Pourquoi ce ticket

Le fichier `CI-ARCHITECTURE.md` est partagé entre les 5 apps Veridian via
symlink racine. Comme c'est versionné côté Hub uniquement et qu'on respecte
la règle "ne touche pas au code des autres repos", l'agent Prospection ne
peut pas patcher directement.

Audit du 2026-05-19 a révélé 8 angles morts opérationnels et la nécessité
d'une politique de promotion différenciée entre Prospection (critique) et
les autres apps. Robert a validé d'étoffer la doc et de désactiver
explicitement l'auto-promote sur Prospection.

## Demande

**Ajouter 2 nouvelles sections à la fin de `veridian-hub/docs/CI-ARCHITECTURE.md`**
(juste après `### 17.6 Couches dormantes — quand activer`, à la fin du fichier
ligne 1206) :

### Section §18 — Angles morts opérationnels (8 sous-sections)

Détaille 8 trous concrets constatés en prod :

- §18.1 Smoke prod CI qui ment sur le SHA déployé (constaté 2× le 2026-05-19)
- §18.2 Dokploy webhook GitHub silently failing
- §18.3 Crons silencieusement KO depuis N jours (cron e2e-cleanup KO 5j)
- §18.4 Logs apps inaccessibles hors SSH → Glitchtip self-hosted
- §18.5 Désalignement Stripe ↔ DB (revenue leak prévention)
- §18.6 Health-check Hub→app pas câblé (contrat §5.5)
- §18.7 Husky NUCLEAR sans qualité → Stryker mutation testing nightly
- §18.8 Time-to-live opaque (durée push→live)

### Section §19 — Politique de promotion différenciée par app

- §19.1 Matrice par app (Prospection = manuel, autres = auto-promote)
- §19.2 Mode Prospection "staging-only ship + giga MAJ"
- §19.3 Mode auto-promote (Hub / Analytics / CMS / Notifuse) — pattern réutilisable
- §19.4 Conditions d'éligibilité auto-promote (3 garde-fous)
- §19.5 Trigger giga-MAJ Prospection (procédure humaine)
- §19.6 Audit de conformité par app

## Contenu exact à ajouter

```markdown
---

## 18. Angles morts opérationnels — détectés en prod

> 🔥 Section ajoutée 2026-05-19 après audit terrain. Ces trous ne sont pas
> théoriques, ils ont **mordu en prod** au moins une fois. Chaque sous-section
> liste : (1) le scénario constaté, (2) la solution proposée, (3) le critère
> objectif "trou colmaté".

### 18.1 Smoke prod CI qui ment sur le SHA déployé

**Scénario constaté** : Push sur `main` → workflow CI/CD passe vert (build OK,
push GHCR OK, smoke prod `GET /api/health` 200 OK). Annonce officielle "deploy
success". **Mais le container prod tournait toujours sur l'image d'il y a 12h**
— Dokploy n'avait pas pull la nouvelle image, le webhook avait foiré
silencieusement.

Détection : par hasard, en testant un nouvel endpoint au curl qui n'existait
pas encore dans l'image active.

**Coût** : Divergence main↔prod silencieuse. Si l'incident n'est pas detecté à
la main, les commits suivants empilent les fonctionnalités absentes de prod.

#### Solution

Chaque app expose `GET /api/version` qui retourne :

​```json
{
  "version": "0.2.0",
  "git_sha": "ad06e50",
  "build_time": "2026-05-19T12:13:14Z",
  "container_started_at": "2026-05-19T12:30:03Z"
}
​```

- `git_sha` injecté au build via `ARG GIT_SHA` dans le `Dockerfile` puis
  exposé en env runtime : `ENV GIT_SHA=${GIT_SHA}` lu par la route.
- Le job CI `smoke-prod` ne se contente plus de `GET /api/health`. Il fait
  aussi `GET /api/version` et **vérifie** que `git_sha` retourné == SHA poussé.
  Si mismatch après 90s de retry → fail le smoke, déclenche `emergency-rollback`.

#### Pattern de smoke renforcé (étage 3 deploy)

​```yaml
- name: Smoke prod (strict SHA check)
  env:
    EXPECTED_SHA: ${{ github.sha }}
  run: |
    for i in $(seq 1 6); do
      VERSION_JSON=$(curl -fsSL "https://${APP}.app.veridian.site/api/version" || echo '{}')
      ACTUAL_SHA=$(echo "$VERSION_JSON" | jq -r '.git_sha // empty')
      if [ "${ACTUAL_SHA:0:7}" = "${EXPECTED_SHA:0:7}" ]; then
        echo "✓ Prod is on $ACTUAL_SHA (expected $EXPECTED_SHA)"
        exit 0
      fi
      echo "⏳ Prod still on $ACTUAL_SHA (attempt $i/6), waiting 15s..."
      sleep 15
    done
    echo "::error::Prod did not reach expected SHA after 90s — Dokploy did not pull"
    exit 1
​```

**Critère "trou colmaté"** : impossible qu'un workflow main passe vert sans que
le SHA prod corresponde exactement au commit pushé.

### 18.2 Dokploy webhook GitHub silently failing

**Scénario constaté** : 2026-05-19, le webhook GitHub→Dokploy n'a pas pull la
nouvelle image après 2 push consécutifs (P1 puis P2.1). Aucune erreur visible.
Il a fallu forcer `compose.deploy` via l'API Dokploy à la main.

**Causes possibles** (non identifiées précisément) :
- `pull_policy: missing` au lieu de `always` côté Dokploy
- Webhook délivré mais file de jobs Dokploy saturée
- Token GHCR expiré côté Dokploy

#### Solution

1. **Vérifier `pull_policy: always`** dans tous les `docker-compose.yml` Dokploy.
   Sans ça, Dokploy peut "redeploy" en restartant le container sans pull.
2. **Webhook redondant** : en plus du webhook GitHub→Dokploy, ajouter en
   fin de pipeline CI un step `compose.deploy` via API Dokploy en redondance.
   La 2e mise à jour est un no-op si la 1ère a marché.
3. **Health-check du webhook** : cron quotidien qui pousse un commit de test
   (genre `chore: webhook-canary [skip ci]`) sur un repo dummy + vérifie
   que Dokploy a reçu et exécuté. Telegram si KO.

​```yaml
- name: Redeploy via Dokploy API (redundancy)
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  env:
    DOKPLOY_API_KEY: ${{ secrets.DOKPLOY_API_KEY }}
    COMPOSE_ID: ${{ vars.DOKPLOY_COMPOSE_ID }}
  run: |
    curl -sS -X POST "https://dokploy.veridian.site/api/compose.deploy" \
      -H "x-api-key: $DOKPLOY_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"composeId\":\"$COMPOSE_ID\"}"
​```

**Critère "trou colmaté"** : §18.1 garantit déjà la détection ; §18.2 garantit
la double-redondance pull.

### 18.3 Crons silencieusement KO depuis N jours

**Scénario constaté** : Le workflow `prospection-e2e-cleanup` (cron quotidien
03:00 UTC) tournait en erreur depuis ~5 jours. Cause : hostname obsolète
(`saas-prospection.staging.veridian.site` au lieu de
`prospection.staging.veridian.site` post-migration Traefik 2026-05-14).
Aucune alerte. Personne n'a remarqué.

**Coût** : Aucun cleanup. Table `auth.users` Supabase qui s'accumule. Risque
de rate-limit signup atteint silencieusement.

#### Solution

1. **Tout cron scheduled DOIT avoir** une notification Telegram `on: failure`.
   Pas un mail GitHub (lu par personne), pas un Slack lointain. Telegram
   ouvert sur le téléphone.

​```yaml
- name: Notify Telegram on failure
  if: failure()
  run: |
    curl -sS "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d chat_id=${TG_CHAT_ID} \
      -d "text=🚨 Cron <b>${{ github.workflow }}</b> failed: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
​```

2. **Cron meta-watchdog** : un job hebdo (dimanche) liste tous les crons
   actifs du repo, vérifie le dernier `conclusion` via GH API, alerte si
   `failure` x≥2 consécutifs.

​```bash
gh api repos/${REPO}/actions/runs --jq '
  group_by(.name) |
  map({
    name: .[0].name,
    last_3: [.[0:3] | .[].conclusion]
  }) |
  map(select(.last_3 | length == 3 and all(. == "failure")))
'
​```

**Critère "trou colmaté"** : impossible qu'un cron échoue 2 fois consécutives
sans alerte Telegram.

### 18.4 Logs apps inaccessibles hors SSH + perdus au restart

**Scénario constaté** : Quand un container restart (rolling deploy), les logs
précédents sont écrasés selon la config Docker (rotation defaults
`max-size=10m, max-file=3`). Si demain un user dit "j'ai eu une erreur ce
matin", on fouille à la main sans contexte.

#### Solution — Glitchtip self-hosted (1 container Dokploy)

Glitchtip = fork OSS de Sentry. **Compatible SDK Sentry**, 1 container vs
5 pour Sentry self-hosted.

| Composant | Effort | Bénéfice |
|---|---|---|
| Glitchtip container Dokploy (postgres + web + worker en 1 compose) | 1h infra | Stack OK |
| SDK `@sentry/nextjs` sur 5 apps Next.js | 30 min × 5 = 2.5h | Capture exception serveur + breadcrumbs auth/Stripe |
| SDK `sentry.io/go` sur Notifuse | 30 min | Idem Go |
| Retention 30j configurée | 5 min | Suffit pour debug post-incident |

Avantage par rapport à Loki/ELK : on capture **les erreurs avec contexte**
(user, tenant, request_id) sans avoir à se taper la centralisation totale
des logs (1000× plus lourd).

**Critère "trou colmaté"** : 100% des erreurs 5xx prod arrivent dans Glitchtip
dans les 30s avec stacktrace + user_id + tenant_id + request_id.

### 18.5 Désalignement Stripe ↔ DB (revenue leak)

**Scénario à venir (pas encore mordu, mais inévitable)** : Stripe envoie
`subscription.deleted` et le webhook Hub plante (5xx, rate-limit, bug code).
Stripe retry mais finit par abandonner. Le tenant garde son plan pro
alors qu'il a annulé. **Aucune réconciliation cron côté Hub**.

#### Solution — Cron reconciliation Hub→Stripe (1 fois/24h)

Côté Hub, cron quotidien qui :

1. Liste tous les tenants avec `planSource = "stripe"` actifs en DB
2. Pour chaque tenant : `stripe.subscriptions.retrieve(stripe_subscription_id)`
3. Compare `tenants.plan` DB vs mapping de `stripe_price_id` actuel
4. Si divergence → log + Telegram + écrit dans `tenants.metadata.reconciliation_pending=true`
5. Action humaine requise (Robert review + click "Force sync") pour résoudre

**Pas de fix automatique** car un downgrade Stripe→free peut être un faux
positif (carte expirée → past_due puis recovery) — l'humain décide.

**Critère "trou colmaté"** : alerte Telegram dans les 24h max pour toute
divergence Stripe ↔ DB plan.

### 18.6 Health-check Hub→app pas câblé (contrat §5.5 non implémenté)

**Scénario constaté** : Le contrat §5.5 exige `GET /api/tenants/{id}/health`
côté chaque app downstream, appelée en cron 1×/h par le Hub. Le endpoint
existe côté Prospection (livré P2.1), mais **le cron Hub appelant n'existe pas**.

Conséquence : si l'api_key Prospection est révoquée silencieusement, le Hub
ne le sait que quand un user clique "Open Prospection" et reçoit 401. UX
dégradée + temps de détection > 1h sur 24h.

#### Solution — Cron Hub `/health` 1×/h par app provisionnée

Côté Hub, workflow scheduled `health-poll.yml` ou job systemd sur prod qui :

1. Liste tous les tenants avec `prospectionProvisionedAt != null`
2. Pour chaque, `GET /api/tenants/{tenant_id}/health` signé HMAC
3. Si `status != "active"` OU `magic_link_capable=false` OU `members_count=0`
   → écrit dans `hub_app.tenant_health_check (tenant_id, app, last_status, last_checked_at)`
4. Si **changement** de status depuis dernière check → Telegram alerte

**Critère "trou colmaté"** : impossible qu'un tenant en état dégradé reste
indétecté > 1h.

### 18.7 Husky NUCLEAR : couverture sans qualité (mutation testing)

**Scénario constaté** : Le hook pre-push vérifie qu'un fichier de test existe
**par nom** (`__tests__/api/<path>.test.ts`). Il ne vérifie **pas que le test
exerce vraiment le code**. Audit du 2026-05-19 a révélé 11 tests bâclés qui
passaient toutes les CI alors que sabotage des invariants ne les faisait pas
échouer (notamment l'émission webhook `tenant.resumed` non assertée).

#### Solution couche 1 — Message anti-bâclage dans la pop-up Husky (livré)

Dans les 5 repos (`Hub`, `Prospection`, `Analytics`, `CMS`, `Notifuse`), la
pop-up `PUSH REFUSÉ` affiche désormais :

​```
message de robert: NE BACLE PAS LES TESTS, il faut les tester
et s'assurer qu'ils soient pertinent et ne casse pas la ci pour
rien et qu'ils durent !
​```

Effet psychologique. Pas suffisant seul.

#### Solution couche 2 — Mutation testing nightly (Stryker)

Outil : `stryker-mutator` pour TS, `gremlins.js` pour Go.

Workflow scheduled hebdo (dimanche 02:00 UTC, low-traffic) :

1. Lance Stryker sur `src/lib/hub/`, `src/lib/queries/`, `src/lib/auth/`
   (libs critiques contractuelles)
2. Calcule le **mutation score** : `mutations tuées / total mutations`
3. Si score < 80% sur un fichier critique → issue GitHub auto + Telegram
4. Dashboard HTML hébergé en GitHub Pages publique

**Pourquoi pas par push** : Stryker coûte 5-10 min même sur un petit
codebase. Trop lourd pour le pipeline ship-fast. Mais **nightly suffit** car
les régressions de qualité mettent des semaines à apparaître, pas des heures.

**Critère "trou colmaté"** : aucun fichier critique sous 80% mutation score
plus de 7 jours.

### 18.8 Time-to-live opaque (durée push→live)

**Scénario constaté** : Pas de métrique sur le temps entre `git push main` et
"le code tourne vraiment en prod". Aujourd'hui c'est entre 5 min (heureux) et
**jamais** (Dokploy ne pull pas — §18.1).

#### Solution

Logger au startup de chaque app, dans les 10s post-démarrage :

​```ts
console.log(JSON.stringify({
  event: "app.live",
  git_sha: process.env.GIT_SHA,
  build_time: process.env.BUILD_TIME,
  started_at: new Date().toISOString(),
  ttl_seconds_since_build: Math.floor((Date.now() - Date.parse(process.env.BUILD_TIME)) / 1000),
}));
​```

Collecté par Grafana Cloud Alloy (déjà installé sur prod). Dashboard
"time-to-live par app" affiche le p50/p95 sur 7j glissants.

**Critère "trou colmaté"** : p95 push→live < 10min sur 7j glissants pour
toutes les apps.

---

## 19. Politique de promotion différenciée par app

> 🔥 Section ajoutée 2026-05-19. Le mode "trunk-based + auto-promote" décrit
> dans le CLAUDE.md racine de veridian-platform n'est **pas universel**.
> Il dépend de la **tolérance à la casse prod** de chaque app.

### 19.1 Matrice par app

| App | Criticité | Promotion staging→main | Tolérance casse prod |
|---|---|---|---|
| **Prospection** | 🔴 Critique | **Manuelle uniquement (giga MAJ)** | Très faible — c'est l'app de revenu actif |
| Hub | 🟡 Important | Auto-promote si staging vert + e2e OK | Faible — bloque flow signup mais récupérable |
| Analytics | 🟢 Standard | Auto-promote si staging vert | Moyenne — analytics manquantes = pas de revenue lost |
| CMS | 🟢 Standard | Auto-promote si staging vert ✅ déjà câblé | Moyenne — sites clients en lecture seule pendant downtime |
| Notifuse | 🟢 Standard | Auto-promote si staging+e2e vert ✅ déjà câblé | Moyenne — emails transactionnels peuvent attendre 30min |

### 19.2 Mode Prospection : "staging-only ship + giga MAJ"

**Règle** : sur Prospection, **JAMAIS d'auto-promote staging→main**. Toute
modif est shipée à volonté sur `staging`. La promotion vers `main` (prod) se
fait par **giga-MAJ humaine** après validation explicite Robert.

#### Garde-fou anti-promotion accidentelle

Le `CLAUDE.md` racine du repo Prospection (`veridian-prospection/CLAUDE.md`)
contient une instruction explicite :

​```markdown
## 🚨 Promotion prod = STRICTEMENT HUMAINE

Prospection est l'app critique Veridian. Aucun agent ne doit jamais faire :
- `git merge --no-ff origin/staging` sur main
- `git push origin main` après staging vert
- `gh workflow run prospection-ci.yml --ref main`

Tout push doit aller exclusivement sur `staging`. La promotion main sera
faite par Robert en mode giga-MAJ explicite (commande "promote prod"
attendue). Si tu as un doute, c'est NON.
​```

#### Workflow `prospection-ci.yml` reste sur `main` mais n'est plus déclenché par push agent

Le workflow garde son trigger `on: push: branches: [main]` (utile pour les
giga-MAJ humaines), mais aucun agent ne le déclenche. Le job `deploy-prod`
n'a pas d'auto-promote du tout — il ne s'exécute que sur push main réel.

### 19.3 Mode auto-promote (Hub / Analytics / CMS / Notifuse)

Pattern de référence : `cms-staging.yml` job `promote-to-main`. Pour câbler
sur Hub et Analytics (manquent encore), copier ce pattern :

​```yaml
promote-to-main:
  name: Auto-promote staging → main
  needs: [deploy, smoke-staging]   # exige staging vert ET smoke vert
  if: github.event_name == 'push' && github.ref == 'refs/heads/staging' && !contains(github.event.head_commit.message, '[skip-prod]')
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: 0
        token: ${{ secrets.GH_AUTOPROMOTE_PAT }}  # PAT scope: repo
    - name: Fast-forward merge staging → main
      run: |
        git config user.email "ci-bot@veridian.site"
        git config user.name "Veridian CI Bot"
        git fetch origin main
        git checkout main
        git merge --ff-only origin/staging || {
          echo "::error::main a divergé de staging — promotion impossible en ff-only"
          exit 1
        }
        git push origin main
    - name: Trigger CI prod
      run: gh workflow run ci.yml --ref main
      env: { GH_TOKEN: ${{ secrets.GH_AUTOPROMOTE_PAT }} }
    - name: Notify Telegram
      if: always()
      run: |
        ICON=$([ "${{ job.status }}" = "success" ] && echo "✅" || echo "🚨")
        curl -sS "https://api.telegram.org/bot${{ secrets.TG_BOT_TOKEN }}/sendMessage" \
          -d chat_id=${{ secrets.TG_CHAT_ID }} \
          -d "text=$ICON ${{ github.repository }} auto-promote staging→main ${{ job.status }}"
​```

### 19.4 Conditions d'éligibilité auto-promote (3 garde-fous)

Pour qu'un app passe en mode auto-promote, **les 3 conditions suivantes
doivent être vérifiées** :

1. **Smoke staging réussit à 100%** (healthcheck + endpoints critiques + e2e Playwright `--project=chromium`)
2. **Migration safety check passe** (cf. §4 Expand & Contract — pas de DROP/RENAME/NOT NULL non gated)
3. **`/api/version` retourne le bon SHA** post-deploy staging (cf. §18.1)

Si une seule condition échoue, promotion bloquée. Investigation manuelle.

### 19.5 Trigger giga-MAJ Prospection (procédure humaine)

Quand Robert valide la giga-MAJ Prospection :

​```bash
# 1. Robert ouvre une session sur l'agent Prospection
# 2. "promote prod maintenant"
# L'agent fait :

git fetch origin
git checkout main
git pull --ff-only
# Si pas ff-only possible : "main a divergé de staging, je veux ton accord pour merge --no-ff" + STOP
git merge --no-ff origin/staging -m "chore: giga-promote staging → main (validated by Robert YYYY-MM-DD)"
git push origin main

# 3. L'agent watch le run CI prod jusqu'à vert
# 4. L'agent smoke prod via curl HMAC + Chrome MCP login pattern
# 5. Si rouge : agent investigue, ne re-promote pas sans accord
​```

### 19.6 Audit de conformité par app

Le job CI étage 1 ajoute un check :

​```bash
# scripts/ci/check-promotion-policy.sh
APP=$(basename $(git rev-parse --show-toplevel))
if [ "$APP" = "veridian-prospection" ]; then
  if grep -q "promote-to-main" .github/workflows/*.yml; then
    echo "::error::Prospection ne doit PAS avoir d'auto-promote (cf. CI-ARCHITECTURE §19.2)"
    exit 1
  fi
else
  if ! grep -rq "promote-to-main" .github/workflows/*.yml; then
    echo "::warning::$APP devrait avoir un job promote-to-main (cf. §19.3)"
  fi
fi
​```

**Critère "trou colmaté"** : aucun PR ne peut introduire de l'auto-promote
sur Prospection ; les autres apps doivent en avoir un (warning).
```

> ⚠️ Note technique : dans les blocs de code ci-dessus, les backticks
> triples ont été remplacés par `​```` (avec ZWJ U+200D) pour éviter le
> casse-tête de nested code fences quand on copie-colle dans le doc.
> Tu peux soit : (a) faire un `sed 's/\`‍/\`\`\`/g'`, soit
> (b) éditer manuellement le markdown rendu, soit (c) demander à l'agent
> Hub de patcher en utilisant le fichier sentinel de l'agent Prospection
> qui contient le markdown propre (voir étape suivante).

## Plus simple — fichier source propre

Plutôt que parser ce ticket à la main, l'agent Hub peut récupérer le bloc
markdown propre depuis :

​```
/home/brunon5/Bureau/veridian-platform/veridian-prospection/todo/2026-05-19-ci-architecture-sections-18-19.md
​```

(fichier déposé par l'agent Prospection en parallèle de ce ticket).
Le contenu y est en markdown standard sans le hack ZWJ. L'agent Hub
n'a qu'à concaténer à la fin de `docs/CI-ARCHITECTURE.md`.

## Critère DoD

- [ ] Sections §18 et §19 présentes à la fin de `veridian-hub/docs/CI-ARCHITECTURE.md`
- [ ] Push sur staging Hub + auto-promote main (Hub n'a pas encore auto-promote — fais aussi le câblage §19.3 si pas fait, sinon merge manuel comme aujourd'hui)
- [ ] Telegram OK
- [ ] Ce ticket marqué `done` et archivé dans `todo/done/`

## Réponse — 2026-05-19 (agent Hub)

✅ **Livré.**

### Ce qui a été fait

- Concaténation propre du fichier source markdown
  `veridian-prospection/todo/2026-05-19-ci-architecture-sections-18-19.md`
  (430 lignes) à la fin de `docs/CI-ARCHITECTURE.md`
  (1206 → 1639 lignes).
- Mise à jour matrice §19.1 : ligne `Hub` → `✅ câblé 2026-05-19` (car le
  ticket parallèle `auto-promote-staging-main.md` est livré en même temps).
- Pas de hack ZWJ à parser : le fichier source côté Prospection était déjà
  propre comme mentionné en fin de ticket.

### Reste à archiver

- [x] §18 et §19 présentes en fin de `docs/CI-ARCHITECTURE.md`
- [x] Matrice §19.1 mise à jour pour Hub
- [ ] Push staging + auto-promote main (cf ticket
      `2026-05-19-auto-promote-staging-main.md` livré en parallèle)
- [ ] Ticket à archiver dans `todo/done/` une fois deploy staging+prod vérifié
