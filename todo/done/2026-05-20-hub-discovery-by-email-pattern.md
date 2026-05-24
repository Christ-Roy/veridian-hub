# [HUB] Pattern Discovery — interrogation apps downstream par email au login

> **Type** : Refactor architectural majeur — long terme
> **Sévérité** : 🟡 P2 (débloque vision "fallback mi-service mi-SaaS")
> **Owner** : agent Hub (spec) + tous les agents apps (impl côté chaque app)
> **Créé** : 2026-05-20
>
> **Avancement 2026-05-23 (agent Hub discovery)** :
> - ✅ **Endpoint Hub `GET /api/users/by-email` livré** sur staging
>   (commits `7e2544c` + `7aefa0f` + `793558b`). Sens **app → Hub** :
>   les apps downstream interrogent le Hub au login user pour découvrir
>   ses apps actives et router. HMAC entrant (réutilise les secrets
>   `<APP>_HUB_API_SECRET` symétriques), rate-limit 60/min/IP + 30/min/app,
>   réponse minimaliste `{exists, tenants:[{app,role}]}`, no-store. 44 tests
>   verts. Voir `lib/discovery/`, `app/api/users/by-email/route.ts`,
>   `__tests__/api/users/by-email.test.ts`, `__tests__/lib/discovery/`.
> - 🟢 Tickets côté apps déposés 2026-05-23 :
>   - `notifuse-veridian/todo/2026-05-23-call-hub-discovery-by-email.md`
>   - `veridian-prospection/todo/2026-05-23-call-hub-discovery-by-email.md`
> - ⏳ Sens inverse (Hub → app pour découvrir users connus de chaque app)
>   non livré — tickets historiques `veridian-cms/todo/2026-05-20-add-
>   discovery-endpoint-by-email.md` et `veridian-analytics/todo/2026-05-20-
>   add-discovery-endpoint-by-email.md` couvrent cette autre direction
>   (pattern décrit ci-dessous §"Pattern cible"). Pas confondre.

## Vision business

Robert veut un modèle **mi-service mi-SaaS** :
- Côté **service** : il provisionne manuellement des clients (skill `cms-provision`, `analytics-provision`, etc.) avec un agent IA
- Côté **SaaS** : le user se logge sur `app.veridian.site` et **voit immédiatement ses apps actives**, sans intervention manuelle pour câbler une row côté Hub

**Aujourd'hui ça ne marche pas** : `hub_app.tenants` est une table dénormalisée
(colonnes `twenty_*`, `notifuse_*`, `prospection_*`, **pas de `cms_*`**). Quand
Robert provisionne manuellement AVSE Monétique côté CMS (skill `cms-provision`),
le Hub n'en sait rien → carte CMS invisible côté dashboard AVSE.

## Pattern cible

Au lieu de **stocker** "user X a CMS / Notifuse / Prospection" côté Hub, le
Hub **interroge** chaque app downstream à la volée :

```
User loggue sur Hub
  ↓
Hub appelle en parallèle (HMAC) :
  - GET notifuse/api/users/by-email?email=user@x.com   → 200 {workspace_id, plan} ou 404
  - GET prospection/api/users/by-email?email=user@x.com → 200 ou 404
  - GET cms/api/users/by-email?email=user@x.com         → 200 ou 404
  - GET analytics/api/users/by-email?email=user@x.com   → 200 ou 404
  ↓
Hub agrège → affiche les cards des apps qui ont répondu 200
```

## Endpoints à standardiser (contrat HMAC)

### `GET /api/users/by-email?email=<email>` (chaque app downstream)

**Auth** : HMAC Hub (cf. CONTRAT-HUB.md §3 Pattern A)

**Response 200** (user connu côté app) :
```json
{
  "found": true,
  "user_email": "user@x.com",
  "workspaces": [
    {
      "workspace_id": "avse",
      "workspace_name": "AVSE Monétique",
      "role": "owner",
      "plan": "complimentary",
      "magic_link_capable": true,
      "fallback_url": "https://cms.veridian.site/admin"
    }
  ]
}
```

**Response 404** (user inconnu) : `{"found": false}`

**Idempotent**, cacheable côté Hub avec TTL 5 min.

### `POST /api/workspaces/<id>/generate-magic-link` (existe déjà sur Notifuse)

Quand le user clique "Open <app>" depuis Hub, le Hub appelle cet endpoint pour
récupérer une URL auto-login. Si l'app ne supporte pas le magic link, le
Hub utilise `fallback_url` (= page login native).

## Architecture côté Hub

### Cache Redis par email

```
Key: hub:user-apps:<email_hash>
TTL: 300s (5 min)
Value: JSON { notifuse: {...}, cms: {...}, prospection: {...} }
```

Invalidation manuelle via :
- Webhook app → Hub `tenant.created` / `tenant.deleted` (déjà spec § contrat HMAC)
- Bouton "Refresh apps" sur dashboard (UX)

### Service `lib/hub/discoverUserApps.ts`

```ts
export async function discoverUserApps(email: string): Promise<DiscoveryResult> {
  const cached = await redis.get(`hub:user-apps:${hash(email)}`);
  if (cached) return JSON.parse(cached);

  const [notifuse, prospection, cms, analytics] = await Promise.allSettled([
    notifuseClient.findUserByEmail(email),
    prospectionClient.findUserByEmail(email),
    cmsClient.findUserByEmail(email),
    analyticsClient.findUserByEmail(email),
  ]);

  const result = aggregateDiscoveryResults({ notifuse, prospection, cms, analytics });
  await redis.setex(`hub:user-apps:${hash(email)}`, 300, JSON.stringify(result));
  return result;
}
```

### Mode de dégradation (fallback)

Si une app répond 5xx ou timeout > 2s, le Hub :
- Skip son card affichage (silent fail)
- Log `[discovery] <app> down for <email>` côté observabilité
- Affiche un "Refresh" sur la card en gris si l'user veut retenter

Pas de cassure du dashboard juste parce qu'une app downstream est down.

## Migration depuis le schéma actuel

La table `hub_app.tenants` reste utile mais devient **read-only legacy** :
- Garder les colonnes `notifuse_*`, `prospection_*` pour les users provisionnés
  AVANT cette migration
- Nouveaux users : pas de row côté `tenants`, tout via discovery

Plus tard (Phase N) : drop la table `tenants` complètement, ne garder que
`subscriptions` (Stripe billing) côté Hub.

## Tickets dérivés

Chaque app downstream doit livrer `GET /api/users/by-email` :

- [ ] `notifuse-veridian/todo/...-add-discovery-endpoint.md` (P1)
- [ ] `veridian-prospection/todo/...-add-discovery-endpoint.md` (P1)
- [ ] `veridian-cms/todo/...-add-discovery-endpoint.md` (P1 — débloque AVSE et autres clients service)
- [ ] `veridian-analytics/todo/...-add-discovery-endpoint.md` (P2 — quand SaaS public)

## Impact court terme — AVSE

Tant que `cms/api/users/by-email` n'existe pas, AVSE n'aura pas de carte CMS
sur son dashboard Hub. Workaround possible :

1. **Hardcoder côté dashboard** : si email ∈ liste, afficher carte CMS fallback
   (lien vers `cms.veridian.site/admin/login`). Sale mais débloquant.
2. **Quick win — `metadata` jsonb** : stocker `tenants.metadata.cms = {...}`
   pour les clients provisionnés par skill manuel. Plus propre que hardcode.

Recommandation : option 2 court terme + ticket discovery long terme.

## Effort

- Hub : 5-7j (discovery service + cache + fallback + UI dashboard)
- Chaque app : 1-2j (endpoint `by-email` + tests intégration)
- Total avec coordination : 3-4 semaines polyrepo

## Référence

- `CONTRAT-HUB.md` §3 (patterns HMAC)
- `CONTRAT-HUB.md` §6bis (autologin 3 couches)
- `todo/2026-05-20-hub-invitation-endpoints.md` (autre refactor cross-app)
- Schéma actuel `prisma/schema.prisma` modèle `Tenant`
