# Sortir les mots de passe Twenty du Hub et de Prospection

> Plan du 06/11/2026. Rien n'est retiré tant que Twenty n'est pas revenu.
> Décision de fond : `SAAS-STANDARDS.md` §1.2 (identité portée par le Hub).

## Ce qui est stocké aujourd'hui (mesuré le 06/11/2026, en base de production)

| Où | Colonne | Lignes avec un mot de passe |
|---|---|---|
| Hub, `hub_app.crm_tenants` | `twenty_password_encrypted` (AES-256-GCM, `CRM_VAULT_KEY`) | **0** (table vide) |
| Prospection, `tenants` | `twenty_user_password` | **0** sur 31 |

Conséquence : il n'y a **aucune donnée à migrer ni aucun mot de passe à révoquer**.
Le risque est uniquement à venir : au retour de Twenty, `app/api/dashboard/crm/activate`
et `app/api/admin/crm/create-tenant` recommenceraient à écrire un mot de passe par client.

## Pourquoi le Hub en stockait un

Une seule raison : `regenerateMagicLink` (`lib/crm/client.ts`) se reconnecte à Twenty
avec le mot de passe pour obtenir un nouveau jeton de connexion. Quatre appelants :
`admin/crm/create-tenant` et `dashboard/crm/activate` (replay idempotent),
`admin/crm/tenants/[id]/magic-link`, `dashboard/crm/regenerate-magic-link`.

Côté Prospection, la colonne n'a plus aucun lecteur : seule la purge la remet à `null`.

## Le plan

| # | Étape | Dépôt | Charge | Condition |
|---|---|---|---|---|
| 1 | Livrer `POST /api/sso/issue-magic-link` (HMAC §6.1) et `GET /api/users/by-email` dans le fork | Twenty | session Twenty, en cours | aucune |
| 2 | Poser `CRM_API_URL` et `CRM_HUB_API_SECRET` dans `nomad/jobs/hub` : le rebond sert Twenty sans code (`lib/auth/bounce-apps.ts`, clé `crm`) | Hub | 10 min | étape 1 en prod |
| 3 | `regenerateMagicLink` appelle `issue-magic-link` au lieu de se reconnecter avec le mot de passe | Hub | 2 h, tests compris | étape 1 en prod |
| 4 | À la création, le mot de passe devient jetable : généré, envoyé à Twenty, jamais écrit. Le compte n'est plus utilisé que par rebond | Hub | 1 h | étape 3 |
| 5 | Migration Prisma : `twenty_password_encrypted` devient nullable, puis suppression après une connexion réelle mesurée | Hub | 1 h | étape 4 en prod |
| 6 | Migration Prisma : suppression de `twenty_user_password` et de sa ligne dans la purge | Prospection | 30 min | indépendante, mais sans urgence : colonne vide |

**Total côté Hub : environ 4 h 30, plus 30 min côté Prospection.** Aucune dépense, aucune
tâche planifiée. `CRM_VAULT_KEY` reste nécessaire : elle chiffre aussi `twenty_api_key_encrypted`.

## Le garde-fou de l'ordre

L'étape 3 doit être en prod **avant** la première activation d'un client sur le Twenty
revenu. Sinon, chaque client activé entre-temps ajoute un mot de passe à effacer. Si
Twenty revient avant : bloquer `crm/activate` plutôt que d'accepter le stock.

## Comment vérifier que c'est fini

```sql
-- Hub : la colonne n'existe plus
select column_name from information_schema.columns
 where table_schema = 'hub_app' and table_name = 'crm_tenants'
   and column_name = 'twenty_password_encrypted';
```

Et une vraie connexion : `/login?next=https://crm.app.veridian.site/`, arrivée connecté
dans Twenty, sans mot de passe en base.
