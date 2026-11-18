# [HUB] Autologin cross-app cassé : Prospection (token usage-unique réutilisé) + Notifuse (creds manquants après link)

> **Sévérité** : 🔴 P1 (casse les démos client — un client cliquant "Ouvrir X" depuis le Hub retombe sur un écran de login)
> **Owner** : agent veridian-hub
> **Créé** : 2026-07-06 par agent (demande Robert, incident démo Céline Gaetan)

## Symptôme
Depuis le dashboard Hub d'un client, cliquer "Ouvrir Prospection" ou "Ouvrir Veridian Mail"
redirige vers l'écran de **login de l'app** au lieu de connecter le client. Vérifié en prod
sur le tenant Céline Gaetan (`fde9285d-70a8-4634-9ea9-f8fc495aebdf`).

## Bug 1 — Prospection : token de login à USAGE UNIQUE réutilisé
**Cause racine** (`app/dashboard/page.tsx:135`) : `prospectionTokenValid` ne teste QUE l'âge
du token (< 23h), **jamais** `prospection_login_token_used`. Le champ `prospectionLoginTokenUsed`
existe (schema ligne 458) mais n'est pas lu. De plus, le Hub ne sait pas quand le token est
consommé côté Prospection (pas de webhook `token.used` → le champ reste `false` en base Hub).

Conséquence : `ProspectionCard.handleOpen` prend le raccourci `if (tokenValid && loginUrl)
window.open(loginUrl)` et rouvre un token DÉJÀ consommé côté Prospection.
Preuve (logs Hub prod) : `[bounce] next_preview: https://prospection.app.veridian.site/login?error=token_used`.

**Fix proposé** (le plus robuste pour une démo) : dans `ProspectionCard.handleOpen`, **toujours**
appeler `/api/prospection/regenerate-login` (supprimer le raccourci `if (tokenValid && loginUrl)`).
Chaque clic = token frais = jamais `token_used`. Coût : 1 appel API (~200ms) par clic, négligeable.
Alternative moins bonne : câbler un webhook Prospection→Hub qui passe `prospectionLoginTokenUsed=true`
+ inclure `&& !used` dans le calcul (fragile, dépend du webhook).

## Bug 2 — Notifuse : colonnes creds non remplies quand le workspace est lié via `hub link`
**Cause racine** : `/api/admin/notifuse/magic-link/route.ts` exige `tenant.notifuseApiKey` +
`tenant.notifuseUserEmail` (sinon 409 `Tenant Notifuse workspace not provisioned`). Le flow
`hub link --app notifuse` (CLI hub-admin) remplit `notifuse_workspace_slug` + `metadata.notifuse`
mais **PAS** ces deux colonnes. Résultat : la route renvoie 409 → `TenantCard.handleOpenService`
fait `window.open(fallback)` = URL nue Notifuse → login.

Ce cas se produit dès qu'un workspace Notifuse est provisionné EN DIRECT (CLI `notifuse`) puis
rattaché au Hub via `hub link`, au lieu du flow natif `/api/notifuse/create-tenant` (qui, lui,
remplit `notifuseApiKey` + `notifuseUserEmail`, cf route lignes 111-124).

**Fix proposé** : `hub link --app notifuse` (côté route `tenants/link-app` + CLI `bin/hub`) doit
aussi renseigner `notifuse_api_key` + `notifuse_user_email` (les accepter en paramètres, ou les
récupérer côté Notifuse). Idéalement, exposer une commande `hub notifuse:link` qui fait le lien
COMPLET. Note : `notifuse_api_key` est stocké/lu **en clair** (pas de chiffrement dans magic-link).

## Contournement appliqué en prod (2026-07-06, pour débloquer la démo Céline)
- Notifuse : `UPDATE hub_app.tenants SET notifuse_api_key='<clé workspace>',
  notifuse_user_email='celine.gaetan@cesaretbrutus.com' WHERE id='fde9285d-...'`.
  Vérifié : `POST /api/workspaces.generateMagicLink` renvoie bien un `auto_login_url`.
- Prospection : non contournable sans deploy (bug code). Reste à corriger.

## Lié
- Le CLI hub-admin (`bin/hub`) devrait poser les creds Notifuse au `link` — cf ticket
  onboarding première connexion.
