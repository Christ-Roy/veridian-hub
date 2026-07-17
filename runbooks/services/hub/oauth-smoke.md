# Runbook — OAuth smoke manuel (Hub)

> **Quand** : après chaque déploiement prod qui touche à l'auth, OAuth, ou
> aux variables d'environnement OAuth (`GOOGLE_*`, `MICROSOFT_*`, callbacks).
> **Aussi** : trimestriel pour valider que les redirect URIs et secrets
> n'ont pas dérivé côté provider.
>
> Le mock OAuth provider (livré 2026-05-21, cf. `reference_mock_oauth_provider.md`)
> court-circuite Google/Microsoft en staging — il ne valide PAS le redirect
> URI réel, le client secret réel, ni le Consent Screen.
> **Ce smoke manuel est le SEUL filet qui exerce le flow OAuth bout-en-bout
> en prod avec un vrai compte Google et un vrai compte Microsoft.**

## Pré-requis

- 1 compte Google **test** (PAS ton compte perso) : ex. `oauth-smoke@gmail.com`
- 1 compte Microsoft **test** (perso ou Entra) : ex. `oauth-smoke@outlook.com`
- Tunnel ou bastion vers Postgres prod (`veridian-core-db`)
- Variable `DATABASE_URL` pointant vers la DB prod (ou staging selon cible)

## Procédure

```bash
cd veridian-hub

# 1. Mettre DATABASE_URL en place (Tailscale recommandé)
export DATABASE_URL="postgresql://veridian:$VERIDIAN_CORE_DB_PASSWORD@<host>:5432/veridian?schema=hub_app"

# Optionnel — pour valider l'email saisi
export OAUTH_SMOKE_TEST_EMAIL_GOOGLE="oauth-smoke@gmail.com"
export OAUTH_SMOKE_TEST_EMAIL_MICROSOFT="oauth-smoke@outlook.com"

# 2. Lancer le smoke
pnpm oauth:smoke:manual
```

Le script :

1. Confirme la cible (`https://app.veridian.site` par défaut)
2. Ouvre `/login` dans Chrome via `xdg-open`
3. Demande de cliquer "Continuer avec Google", login, retour
4. Vérifie en DB que :
   - L'user a bien été créé
   - `supabaseUserId` est posé (régression du fix d25f575 du 2026-05-21)
   - Un `Account` `provider=google` est rattaché
5. **Supprime le user créé** (cleanup), avec sessions + accounts + tenants
6. Répète pour Microsoft (`provider=microsoft-entra-id`)
7. Affiche un récap final pass/fail

## Critères PASS

- ✓ User créé en DB pour chaque provider
- ✓ `supabaseUserId` posé (non-null, UUID v4)
- ✓ Cleanup effectif (user supprimé après vérification)
- ✓ Pas de redirect inattendu (le navigateur reste sur app.veridian.site, pas
  d'erreur `redirect_uri_mismatch`, `invalid_client`, ou `OAuthAccountNotLinked`)

## Critères FAIL → action immédiate

| Symptôme | Diagnostic |
|---|---|
| `redirect_uri_mismatch` côté Google | Le callback déclaré dans GCP Console diffère de ce qu'Auth.js envoie. Vérifier `console.cloud.google.com/auth/clients` projet `veridian-preprod`. |
| `invalid_client` côté Microsoft | Le secret a expiré (vérifier `az ad app credential list --id 44621507-2ab6-4cb4-8f90-2e6a9cc9e8d8 --query "[].endDateTime"`). Rotation : cf. `reference_microsoft_entra_oauth.md` §"Procédure rotation secret". |
| `supabaseUserId` NULL en DB | Régression du fix 2026-05-21. Vérifier que l'event `createUser` dans `auth.ts` est toujours câblé. |
| User pas trouvé en DB | Le flow OAuth n'a pas abouti (browser session interrompue, ou erreur côté Auth.js callback). Voir les logs du job Hub : `nomad-v logs hub`. |

## Lien avec la CI

- Le filet automatisé est **staging only** (mock provider + E2E `04-oauth-flows.spec.ts`)
- Ce smoke est le **complément manuel post-deploy prod** — pas câblé en CI
  parce qu'aucun moyen sain d'automatiser un vrai login Google/Microsoft
  sans exposer un secret de compte test dans GitHub Actions
- Le cron `oauth-health-cron.yml` complète en surveillant l'expiration du
  secret Microsoft et la disponibilité du discovery doc Google
