# [HUB] Quick win — Card CMS fallback pour AVSE en attendant le pattern discovery

> **Type** : Quick win pre-Phase 2 — débloquer AVSE Monétique côté UX dashboard
> **Sévérité** : 🟡 P2 (utile mais pas bloquant — workaround acceptable)
> **Owner** : agent Hub
> **Créé** : 2026-05-20
> **Bloqué par** : aucun (peut être livré tout de suite)

## Contexte

AVSE Monétique (`avse.monetique@gmail.com`) :
- Existe côté **CMS Payload** : tenant `avse` (id=1), user admin créé
- Existe pas encore côté **Hub** (sera créé au premier login Google grâce à
  `allowDangerousEmailAccountLinking`)
- Pas de carte CMS visible côté dashboard Hub car schéma `hub_app.tenants`
  n'a pas de colonnes `cms_*`

Le pattern propre (Hub interroge CMS via discovery par email) est documenté
dans `2026-05-20-hub-discovery-by-email-pattern.md` mais demande 3-4 semaines
de coordination polyrepo.

**Quick win demandé par Robert** : pouvoir activer manuellement une carte
CMS pour AVSE (et autres clients similaires) en attendant.

## Solution proposée

### Stocker dans `tenants.metadata` jsonb

Pas de migration Prisma. Le champ `metadata jsonb` existe déjà sur
`hub_app.tenants`. On stocke :

```json
{
  "cms": {
    "tenant_id": 1,
    "tenant_slug": "avse",
    "tenant_name": "AVSE Monétique",
    "plan": "complimentary",
    "provisioned_at": "2026-05-20T11:00:00Z",
    "provisioned_by": "skill-cms-provision",
    "fallback_url": "https://cms.veridian.site/admin"
  }
}
```

### Côté dashboard `app/dashboard/page.tsx`

Lire `tenant.metadata?.cms` :
- Si présent → afficher une `ServiceCard` CMS avec :
  - Title : "Veridian CMS — {tenant_name}"
  - Description : "Gérez le contenu de votre site"
  - Bouton "Ouvrir" → `metadata.cms.fallback_url`
  - Badge "Service Veridian" (vs "SaaS self-service")
- Si absent → soit `ShadowAppCard` (marketing) soit rien selon le plan

### Script provisioning Hub admin

`scripts/admin/link-cms-tenant.sh <hub_user_email> <cms_tenant_slug>` :

```bash
#!/usr/bin/env bash
# Lie un tenant CMS existant à un user Hub via metadata.
# Usage: link-cms-tenant.sh avse.monetique@gmail.com avse
set -euo pipefail

EMAIL=$1
CMS_SLUG=$2

ssh prod-pub "docker exec compose-parse-multi-byte-feed-ywg73b-veridian-core-db-1 \
  psql -U veridian veridian -c \"
    UPDATE hub_app.tenants
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{cms}',
      jsonb_build_object(
        'tenant_slug', '${CMS_SLUG}',
        'plan', 'complimentary',
        'provisioned_at', NOW()::text,
        'fallback_url', 'https://cms.veridian.site/admin'
      )
    )
    WHERE user_id = (
      SELECT supabase_user_id::uuid FROM hub_app.users WHERE email = '${EMAIL}'
    );
  \""
```

### Quand le pattern discovery sera prêt

Migration douce : `tenants.metadata.cms` reste actif comme **fallback cache**
si l'endpoint CMS discovery ne répond pas, sinon discovery prend le pas.

## Action AVSE concrète

1. **Pré-créer user Hub** pour AVSE (sans attendre login Google) :
   ```sql
   INSERT INTO hub_app.users (id, email, name, supabase_user_id, created_at, updated_at)
   VALUES (gen_random_uuid()::text, 'avse.monetique@gmail.com', 'Didier Bollard', gen_random_uuid(), NOW(), NOW());
   ```
2. **Créer tenant Hub vide** avec metadata.cms :
   ```sql
   INSERT INTO hub_app.tenants (id, user_id, name, slug, status, metadata, created_at, updated_at)
   VALUES (
     gen_random_uuid(),
     (SELECT supabase_user_id::uuid FROM hub_app.users WHERE email = 'avse.monetique@gmail.com'),
     'AVSE Monétique',
     'avse',
     'active',
     jsonb_build_object('cms', jsonb_build_object(
       'tenant_slug', 'avse',
       'plan', 'complimentary',
       'provisioned_at', NOW()::text,
       'fallback_url', 'https://cms.veridian.site/admin'
     )),
     NOW(), NOW()
   );
   ```
3. **Modifier dashboard** pour afficher la card si `tenant.metadata.cms` présent
4. **Login AVSE via Google** sur app.veridian.site → grâce à
   `allowDangerousEmailAccountLinking`, son nouveau OAuth account se link au
   user Hub pré-créé → il voit sa card CMS

## Effort

- 1-2j (script provisioning + composant ServiceCard CMS + tests RTL)

## Référence

- Vision long terme : `todo/2026-05-20-hub-discovery-by-email-pattern.md`
- Skill `cms-provision` (mode service Robert) : `~/.claude/skills/cms-provision/SKILL.md`
- CONTRAT-HUB.md §8.9 (apps client_only)
