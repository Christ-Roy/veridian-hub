# [HUB] Checklist de promotion `staging` → prod

> **Sévérité** : 🔴 P0 (rien ne part en prod tant que §1 n'est pas vert)
> **Créé** : 2026-07-28 par agent hub (suite du chantier cookie hint / déconnexion)
> **Décideur** : Robert — cette checklist prépare, elle ne déclenche rien
> **État à la rédaction** : promotion **BLOQUÉE**, trois causes indépendantes (§1)

---

## TL;DR

1. **Le plus gros du travail n'est pas poussé.** 11 commits vivent en local sur
   `staging` et n'ont jamais atteint `origin` — dont le fix du build, le fix de la
   CVE critical Auth.js et le fix autologin. Tant qu'ils sont là, `origin/staging`
   est plus mauvais que la copie locale, et la CI juge une version périmée.
2. **La CI est rouge pour trois raisons, pas une** : build cassé, CVE bloquantes,
   Trivy. Le build est **déjà réparé et vérifié** (§1.2), la CVE critical aussi ;
   il reste **6 CVE high** qui bloquent le gate et ne dépendent pas de nous (§1.3).
3. **Aucune migration Prisma dans l'écart.** Rien à appliquer à la main, et de
   toute façon le Hub migre au boot du conteneur.
4. **Une fonctionnalité est cassée en prod indépendamment de cette promo** :
   l'invitation cross-app répond `503` pour les 4 apps (secrets jamais déployés).
   Ce n'est pas une régression, ça n'a jamais été activé. À traiter à part.

---

## §1. Ce qui bloque, dans l'ordre

### 1.1 🔴 Pousser `staging` (préalable à tout)

`origin/staging` est en retard de **11 commits** sur la copie locale du bastion :

```
1d814ef docs(todo): corrige le contrat Analytics — nommage HMAC, repo, identite Hub
8c485be fix(dev): repare le setup local — collision de port 5433 / Patroni staging
d01e075 fix(security): next 15.5.18 -> 15.5.22
7f1461f fix(analytics): le bouton Ouvrir menait sur le domaine Analytics mort (404)
ab3ffae docs(todo): autologin Analytics — etat reel sonde + contrat pour l'engine
2bfbd47 test(auth): verrouille le fail-closed du middleware et les plafonds de reset
11c03f7 fix(security): next-auth 5.0.0-beta.32 + ferme le fail-open du middleware
42f3cfd test(auth): fiabilise les deux tests bypass E2E de signup
48f4d9e fix(build): sort les rate-limiters du route.ts reset_password
b223791 fix(autologin): repare l'ouverture des apps pour un tenant lie par hub link
5c89f3b feat(dev): atelier UI hot-reload pour l'onboarding première connexion
```

⚠️ Ces commits appartiennent à **plusieurs agents**. Avant de pousser, s'assurer
qu'aucun n'a de travail en cours dans le même arbre : le working tree porte
encore ~90 fichiers modifiés (conversion CRLF→LF non commitée) et une quinzaine
de fichiers non suivis. **Ne jamais faire `git add -A` ici.**

Une fois poussé, la CI se déclenche sur `staging` et le déploiement staging
suit automatiquement (`.github/workflows/hub-staging.yml`).

### 1.2 ✅ Build — corrigé, vérifié

Dernier run CI rouge (`30350320834`) :

```
Type error: Route "app/(auth)/auth/reset_password/route.ts" does not match
the required types of a Next.js Route.
```

Cause : `df702b7` exportait des rate-limiters depuis un `route.ts`, ce que Next
interdit. Le correctif est `48f4d9e` (rate-limiters sortis du fichier), présent
en local, **non poussé**.

**Vérifié le 2026-07-28** : `next build` sur l'état commité (HEAD `1d814ef`),
dans un worktree isolé, sort en **EXIT=0**. Le build redevient donc vert dès que
§1.1 est fait. Ce blocage-là est réglé.

⚠️ Ne pas juger le build depuis le working tree du bastion : il est partagé
entre agents et régulièrement incohérent (au moment de ce test, un refactor
analytics en vol — suppression staged d'un composant encore présent sur disque —
faisait échouer le build local sur une erreur qui n'existe dans aucun commit).
Le seul juge fiable est la CI sur le commit poussé, ou un worktree isolé.

### 1.3 🔴 CVE — la critical est réglée, 6 high restent bloquantes

Le job `CVE audit (high+critical bloquant)` échoue. État réel mesuré en local
après les fixes non poussés :

| Sévérité | Paquet | Corrigé dans | Statut |
|---|---|---|---|
| ~~critical~~ | ~~next-auth (GHSA-8fpg-xm3f-6cx3)~~ | 5.0.0-beta.32 | ✅ réglé par `11c03f7` |
| high | `fast-uri` | ≥ 3.1.3 / ≥ 3.1.4 | ❌ bloque |
| high | `brace-expansion` (×3 chaînes) | ≥ 1.1.16 / 5.0.7 / 5.0.8 | ❌ bloque |
| high | `js-yaml` | ≥ 4.3.0 | ❌ bloque |

Les 4 restantes sont des dépendances **transitives** (eslint, ajv). Un agent
dédié traite le lot des 43 CVE du repo — se caler sur lui plutôt que de patcher
en double. Sans ce job vert, `deploy-prod` ne s'exécute pas.

### 1.4 🟠 Trivy FS / Trivy image

Échouait sur la même CVE Auth.js. Devrait redevenir vert avec `11c03f7`, à
confirmer. `trivy` est un `needs:` de `deploy-prod` : rouge = pas de déploiement.

---

## §2. Ce qui part en prod (écart `origin/main` → `origin/staging`)

**15 commits**, dont 5 rapports CVE automatiques et 4 commits de documentation.
Le contenu applicatif réel :

| Commit | Nature | Risque |
|---|---|---|
| `0661e49` | Suppression du cookie hint au signOut + `/api/me/lite` rendu autoritaire | 🟡 touche l'auth, vérifié bout en bout sur staging (§5.1) |
| `eef9608` | Tests du helper de déconnexion client | 🟢 tests seuls |
| `df702b7` | Rate-limit sur `/auth/reset_password` + anti-énumération | 🔴 **a cassé le build**, corrigé par `48f4d9e` non poussé |
| `31ec184`, `dc4c8a4` | Hooks de session Claude Code | 🟢 outillage local, pas de runtime prod |
| `b3b8068`, `b399831` | Docs Dokploy → Nomad | 🟢 |

⚠️ `origin/main` porte **1 commit absent de staging** : `1371dda fix(security):
redact obsolete webhook secrets (#26)`. La promotion doit donc être un **merge**,
pas un fast-forward. Un `git merge origin/staging` sur `main` le préserve ; une
promo faite par force-push le perdrait.

### Migrations DB

**Aucune migration Prisma dans l'écart** (`git diff --name-only
origin/main...origin/staging -- prisma/migrations` est vide). Rien à ordonner,
rien à appliquer à la main.

Rappel de mécanique : le Hub applique `prisma migrate deploy` **au boot du
conteneur** (CMD du Dockerfile, idempotent, advisory lock Postgres). Un migrate
qui échoue = conteneur jamais healthy = `auto_revert` du job Nomad restaure la
version saine. Il n'y a plus de job `migrate-prod` dans la CI.

---

## §3. Variables d'environnement manquantes en prod

### 3.1 `HUB_INVITATION_SECRET_*` — 4 secrets absents, fonctionnalité morte en prod

Sondé en live le 2026-07-28, `POST /api/invitations/create` sur
`app.veridian.site` avec une signature bidon :

| App | Prod | Staging |
|---|---|---|
| notifuse | `503 HUB_INVITATION_SECRET_NOTIFUSE not configured` | `401 invalid signature` |
| prospection | `503 … PROSPECTION not configured` | — |
| analytics | `503 … ANALYTICS not configured` | — |
| cms | `503 … CMS not configured` | — |

Le `401` en staging prouve que le secret y est présent ; le `503` en prod que
l'ENV n'est pas câblée. **Ce n'est pas une régression** : la fonctionnalité n'a
jamais été activée en prod.

Il manque aux **deux** endroits :

1. `deploy/hub.nomad.hcl` (source de vérité du déploiement prod — pas le HCL du
   bastion, cf. le commentaire du workflow) : les 4 lignes existent dans
   `deploy/hub-staging.nomad.hcl` lignes 204-207, à transposer.
2. La Nomad Variable `nomad/jobs/hub` : 23 clés présentes, **aucune** des 4.

🔴 **À vérifier AVANT de générer quoi que ce soit** : aucune app downstream
(`nomad/jobs/notifuse`, `nomad/jobs/prospection`) ne porte de clé d'invitation en
prod non plus. Le secret doit être **identique des deux côtés** — c'est un HMAC
partagé. Générer une valeur côté Hub seul ne réparerait rien et donnerait
l'illusion que c'est fait. Identifier d'abord qui signe en face, sinon laisser
le `503`, qui est un échec franc et lisible.

### 3.2 Le reste des écarts staging/prod est normal

`OAUTH_TEST_PROVIDER` (staging seul, vérifié par un check CI dédié),
`STRIPE_*_TEST` vs `_LIVE`, `GOOGLE_MAIL_*` vs `GOOGLE_OAUTH_*`,
`NEXT_PUBLIC_GTM_ID`, `TZ`, `POSTGRES_*`. Rien à faire.

✅ `SESSION_HINT_SECRET` **est** présent dans `nomad/jobs/hub` — le fix de
déconnexion n'a besoin d'aucune variable nouvelle.

---

## §4. Ordre d'exécution

1. Confirmer qu'aucun agent n'a de travail en vol dans l'arbre, puis **pousser
   `staging`** (11 commits).
2. Attendre la CI sur `staging` : `Build check` **vert**, `CVE audit` **vert**,
   `Trivy FS` **vert**. Si le CVE audit reste rouge → attendre l'agent CVE, ne
   pas contourner le gate.
3. Vérifier le déploiement staging automatique (`hub-staging.yml`) et refaire le
   smoke §5.1 sur `hub.staging.veridian.site`.
4. Ouvrir la PR `staging` → `main` (**merge**, jamais de force-push, cf. §2).
5. Le merge sur `main` déclenche `deploy-prod` (build image → Trivy → `nomad job
   plan` puis `run -detach` via SSH bastion). Migrations au boot, `auto_revert`
   en cas de conteneur non healthy.
6. Dérouler §5 sur la prod.
7. Traiter §3.1 séparément — ce n'est pas un bloquant de cette promo.

---

## §5. Vérifications après déploiement prod

### 5.1 Parcours de déconnexion (le fix de cette promo)

Exactement le protocole validé sur staging le 2026-07-28. Sur `app.veridian.site` :

```bash
# a) le signOut doit effacer les DEUX cookies
CSRF=$(curl -s -c jar https://app.veridian.site/api/auth/csrf | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b jar -D - -o /dev/null -X POST https://app.veridian.site/api/auth/signout \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "callbackUrl=/" | grep -i set-cookie
```

Attendu, sur une **302** :
```
set-cookie: veridian-session-hint=; Path=/; Max-Age=0; Domain=.veridian.site; Secure; SameSite=lax
```
C'est le marqueur que le fix est en ligne. Aujourd'hui la prod ne le renvoie pas.

```bash
# b) hint orphelin : réponse false ET cookie effacé
curl -s -D - https://app.veridian.site/api/me/lite \
  -H "Origin: https://veridian.site" -H "Cookie: veridian-session-hint=<un hint valide>"
```
Attendu : `{"authenticated":false}` + `set-cookie: veridian-session-hint=; Max-Age=0`
+ `access-control-allow-credentials: true` (sans ce header le navigateur
ignorerait la suppression en cross-origin).

c) Sur `veridian.site` avec un vrai navigateur : se connecter, se déconnecter,
la navbar doit repasser sur « Connexion ». Non testable sur staging, il n'y a
pas de landing staging — **c'est la seule vérification qui n'a pu être faite
qu'en prod**.

d) Google One Tap doit se réafficher pour un utilisateur déconnecté (le garde-fou
`if (loading || authenticated) return` ne doit plus être bloqué par un hint
fantôme). One Tap est désactivé en staging → jamais testé ailleurs qu'en prod.

**Cas de Robert** : son navigateur porte un hint fantôme. Après ce déploiement,
il se répare tout seul au premier `/api/me/lite`. Avant, la seule solution est de
supprimer le cookie `veridian-session-hint` à la main sur `veridian.site`.

### 5.2 Autologin cross-app

Le fix `b223791` (« ouverture des apps pour un tenant lié par hub link ») est
dans les commits **non poussés** — il ne partira que si §1.1 est fait. Après
déploiement : ouvrir une app depuis le dashboard d'un tenant lié par hub link
et vérifier qu'on arrive loggué, pas sur un 404 ni sur un écran de login.

Voir aussi `todo/2026-07-06-autologin-cross-app-casse.md` et
`todo/2026-07-28-autologin-analytics-contrat-et-etat-reel.md` : côté Analytics,
la route SSO n'existe toujours pas côté engine, ne pas s'attendre à ce que ça
marche pour cette app.

### 5.3 Smoke général

- `GET /api/health` → 200
- Connexion Google réelle sur `app.veridian.site`
- Un `/dashboard` qui charge pour un tenant existant (vérifie la DB et les
  migrations au boot)
- `GET /api/me/lite` sans cookie → `{"authenticated":false}`
- Logs Nomad de l'alloc : pas de `[auth-error][critical]`, pas d'échec Prisma

### 5.4 Si ça tourne mal

Pas de rollback automatique après coup : `auto_revert` ne couvre que le cas
« conteneur jamais healthy ». Un déploiement healthy mais fonctionnellement
cassé se rattrape à la main : `git revert` + push sur `main` → redéploiement du
SHA précédent, puis surveillance. Cf. `deploy/README.md` §7.

---

## Ce que cette checklist ne couvre pas

- Le lot des **43 vulnérabilités** signalées par GitHub sur la branche par défaut
  (5 critical, 16 high) : chantier séparé, agent dédié.
- La **collision de port 5433** entre les postes de dev et le Patroni staging
  (cf. `scripts/dev/README.md`) : ça ne touche pas la prod, mais un dev qui
  utilise le mot de passe staging écrit dans la base staging sans le savoir.
- Le nettoyage du working tree du bastion (~90 fichiers CRLF non commités).
