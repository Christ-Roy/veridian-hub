# [HUB] 🟡 P1 — Câbler la SORTIE du score prospect vers le CRM Twenty (push priorisation)

> **Sévérité** : 🟡 P1 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)
> **Type** : feature — branche la SORTIE du réconciliateur (Lot 2 prévu par `2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md`)

## Contexte (prouvé par audit 2026-06-17)

Le réconciliateur Lot 1 est EN PROD : il ingère les events comportementaux
Notifuse (`email.opened/clicked/replied`), calcule un `engagementScore` et
l'écrit dans `hub_app.prospect_scores` (`lib/prospect/ingest.ts` + `scoring.ts`).

**Le score est calculé et persisté, mais JAMAIS RELU.** Preuves :

- `grep -rn 'prospectScore\.(findMany|findFirst|findUnique|aggregate|groupBy|count)' app/ lib/ utils/` (hors `lib/prospect/ingest.ts`) → **VIDE**.
- `grep -rn 'engagementScore|ProspectScore|prospect_scores' app/ components/ lib/ utils/` (hors module prospect) → **VIDE**.
- Les seuls importeurs de `lib/prospect/` sont les deux émetteurs d'ingestion
  (`app/api/webhooks/notifuse/route.ts`, `lib/webhooks/notifuse-handlers.ts`).

Le score est donc une **impasse d'écriture** : la table `prospect_scores`
existe, l'index `(workspace_slug, engagement_score DESC)` est prêt pour un
"top N chaud"... et rien ne le consomme. **Sans ce ticket, tout le Lot 1 ne
sert à rien** : on score dans le vide.

C'est explicitement le débouché central déclaré manquant :

- `docs/CONTRAT-HUB.md §7.5.4` : *« L'écriture du score dans le CRM Twenty
  (priorisation) : hors périmètre du socle d'ingestion (lot suivant). »*
- Ticket source §"Reste à faire" : *« Push vers CRM Twenty des prospects
  chauds (scoring → priorisation). »*
- Le but produit gravé dans le schéma Prisma (`schema.prisma:848`) :
  *« scorer le prospect et prioriser les chauds dans le CRM Twenty. »*

## État du terrain CRM (vérifié via MCP twenty-crm 2026-06-17)

Le CRM Twenty est **déjà prêt à recevoir le score** — il manque juste le câblage :

- L'objet Twenty **`people`** a DÉJÀ deux champs numériques : **`prospectScore`**
  et **`score`** (vérifiés dans le metadata du workspace). Le champ
  `emails.primaryEmail` = exactement la clé de jointure V1 du réconciliateur
  (`prospect_scores.contact_email`).
- L'objet **`cold_prospects`** n'a PAS de champ score (juste name, telephone,
  societe, source, statut, promu, doNotContact, notes). La cible naturelle du
  push est donc **`people.prospectScore`**, joint par email.

## ⚠️ Le client CRM existant ne sait PAS encore pousser le score

`lib/crm/client.ts` existe (`CrmClient`), MAIS :

- Il n'est **importé nulle part hors `lib/crm/`** (prouvé). Même le `pushLeads`
  basique n'est câblé sur aucune route/cron → le CRM ne reçoit AUCUNE data du
  Hub aujourd'hui.
- `pushLeads()` POST `/rest/people` avec un body limité à `{ name, emails }` —
  **aucun champ `prospectScore`**, et c'est un CREATE (pas un upsert/patch par
  email). Il ne sait donc ni écrire le score, ni mettre à jour un `people`
  existant.

Il faut donc **étendre `lib/crm/client.ts`** (pas juste appeler l'existant).

## Demande précise

### 1. Étendre le client CRM (`lib/crm/client.ts` + `lib/crm/types.ts`)

Ajouter une méthode dédiée, ex. `upsertProspectScore`, qui pour un prospect
(email + score + signaux) :

- Cherche le `people` existant par `emails.primaryEmail` via
  `GET /rest/people?filter=emails.primaryEmail[eq]:<email>` (REST Twenty).
- S'il existe → `PATCH /rest/people/{id}` avec `{ prospectScore: <score> }`
  (et éventuellement `score` selon ce que Robert veut comme champ d'affichage).
- S'il n'existe pas → `POST /rest/people` avec name + emails + `prospectScore`
  (création du prospect chaud directement dans le CRM).
- Best-effort par prospect (collecte les erreurs par index comme `pushLeads`
  le fait déjà — ne pas abort au 1er échec).

Garder le même garde-fou : timeout configurable, retry léger 5xx/réseau
uniquement, aucun secret loggué.

### 2. Créer le cron de push (calqué sur `app/api/cron/reconcile-tenants/route.ts`)

Pattern STRICTEMENT identique à l'existant (ne PAS réinventer) :

- Route `POST /api/cron/push-prospect-scores/route.ts` :
  - `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `maxDuration` adapté.
  - Auth `Authorization: Bearer <CRON_SECRET>` (même check que reconcile).
  - Thin wrapper → toute la logique dans `lib/prospect/push-to-crm.ts`
    (testable unitairement, comme `lib/sync/reconcile.ts`).
  - GET d'observabilité (description + schedule), comme reconcile-tenants.
- Logique `lib/prospect/push-to-crm.ts` :
  - Lit le top N de `prospect_scores` par workspace au-dessus d'un seuil
    (ex. `engagementScore >= SEUIL`, `SEUIL` en ENV, défaut à trancher —
    suggérer 5 = au moins un clic), via l'index
    `(workspace_slug, engagement_score DESC)` déjà présent.
  - Résout le `CrmTenant` du workspace (via `workspace_slug` → tenant Hub →
    `getCrmTenantByUserId` / lookup crm_tenants) pour récupérer le
    `twentyWorkspaceUrl` + API key déchiffrée (`lib/crm/vault.ts#decryptSecret`).
  - Appelle `client.upsertProspectScore` pour chaque prospect chaud.
  - **Idempotence / anti-spam push** : ajouter une colonne
    `prospect_scores.crm_pushed_at` (+ `crm_pushed_score`) pour ne re-pousser
    qu'en cas de changement de score depuis le dernier push (migration
    versionnée — tier 🔴, staging d'abord, body commit `Existing tenants:`).
- Workflow GH Actions `hub-push-scores-cron.yml` (calqué sur
  `hub-reconcile-cron.yml`) — schedule à trancher (horaire ou 6h).

### 3. Mettre à jour la doc

- `docs/CONTRAT-HUB.md §7.5.4` : retirer le point « écriture du score dans le
  CRM hors périmètre » → le documenter comme livré (§7.5.5 push CRM).
- Ticket source `2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md` :
  cocher « Push vers CRM Twenty » dans le "Reste à faire".

## Impact business

**C'est LE débouché qui donne sa valeur au réconciliateur.** Sans lui, on a
livré en prod un moteur de scoring dont la sortie part dans le vide. Avec lui,
Robert voit dans son CRM Twenty quels prospects ont ouvert/cliqué/répondu, triés
par chaleur → priorisation cold-call réelle (le `statut` cold-call de
`cold_prospects`/`people` existe déjà pour ça).

## Dépendances / ordre

- **Indépendant du vid** (étage 2) : la jointure V1 par `contact_email` suffit
  pour pousser le score sur `people.emails.primaryEmail`. Ne PAS attendre le vid.
- **Dépend du mapping `workspace_slug` → CrmTenant** : vérifier que le lien
  workspace Notifuse → CrmTenant Hub existe pour les tenants qui ont un CRM.
  Si le mapping est lâche, commencer par le(s) workspace(s) de Robert lui-même
  (dogfooding) avant d'élargir.
- **Migration `crm_pushed_at`** = tier 🔴 (ALTER ajout colonne nullable, non
  destructif) → staging d'abord, E2E lourd, puis prod.

## Tier de risque (CI-ARCHITECTURE §20)

🔴 HAUT (nouvelle route cron + migration + appel sortant vers CRM prod). Reco
écrite + `pnpm e2e:staging:full` + monitoring 10 min post-deploy avant promo main.
