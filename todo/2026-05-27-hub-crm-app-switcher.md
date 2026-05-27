# [HUB] App Switcher cross-app injecté dans CRM (et autres apps)

> **Sévérité** : 🔵 P3
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Roadmap UX premium audit `/tmp/audit-crm-needs-2026-05-27.md` §C.3 + §F.1
> - Pattern existant Hub : dashboard cards (`ProspectionCard`, `ShadowAppCard`)

## Contexte

Aujourd'hui, un user Veridian qui est dans Notifuse / Prospection / CRM
doit **revenir au dashboard Hub** pour basculer vers une autre app. Pas
de menu unifié type "barre Veridian" cross-app.

Twenty propose nativement un workspace switcher (multi-workspace par
user). L'équivalent **cross-app Veridian** serait un `<VeridianAppSwitcher>`
injecté dans le header de chaque app via un script JS chargé depuis le
Hub (pattern miroir d'Intercom, Sentry SDK).

C'est la touche UX qui transforme la "stack d'apps Veridian" en "suite
Veridian unifiée".

## Action attendue

### 1. Endpoint Hub : script tag injection

```
GET /api/app-switcher/embed.js
```

Retourne un script JS minifié qui :
1. Lit l'origin / le contexte (quelle app on est)
2. Fetch la liste des apps de l'user via `GET /api/users/me/apps`
3. Inject un `<div id="veridian-app-switcher">` flottant en haut à droite
   (z-index élevé, n'interfère pas avec l'UI de l'app)
4. Au click → menu déroulant avec icônes + noms + status (Active / Trial / Locked)
5. Click sur une app → POST `/api/auth/cross-app-magic-link` → redirect
   vers l'app cible (avec auto-login déjà câblé Hub→Notifuse/Prospection,
   et magic link `/verify?loginToken=...` pour CRM)

### 2. Endpoint Hub : list des apps user

`GET /api/users/me/apps` (auth Hub session ou Bearer cross-app) :

```json
{
  "apps": [
    {
      "key": "notifuse",
      "name": "Veridian Notifuse",
      "iconUrl": "https://app.veridian.site/icons/notifuse.svg",
      "status": "active",
      "openUrl": "/api/tenants/notifuse/magic-link"
    },
    {
      "key": "prospection",
      "name": "Veridian Prospection",
      "iconUrl": "...",
      "status": "trial",
      "trialEndsAt": "2026-06-15",
      "openUrl": "/api/tenants/prospection/login"
    },
    {
      "key": "crm",
      "name": "Veridian CRM",
      "iconUrl": "...",
      "status": "active",
      "openUrl": "/api/admin/crm/tenants/<id>/magic-link"
    }
  ],
  "currentApp": "crm"
}
```

### 3. Injection dans les apps

**CRM (Twenty fork)** : injecté via un `<script async src="https://hub.veridian.site/api/app-switcher/embed.js">` ajouté dans le `index.html` Twenty (modif AGPL safe, juste un ajout dans le template HTML public). À coordonner via ticket dans `veridian-crm-repo/todo/`.

**Notifuse / Prospection** : idem, ajout du script tag dans le shell HTML root.

**Hub** : pas besoin d'injection — le dashboard root EST déjà le hub.

### 4. UX du switcher

```
┌──────────────────────────┐
│ ▼ Veridian CRM           │  ← clickable, état actuel
└──────────────────────────┘
       ↓ (click)
┌──────────────────────────┐
│ → Veridian Notifuse ✓    │
│ → Veridian Prospection 🟡 │  (trial)
│ • Veridian CRM (current) │
│ ─────────────────────    │
│ + Découvrir Analytics    │  (not provisioned)
│ + Découvrir CMS          │
│ ─────────────────────    │
│ 🏠 Mon dashboard Hub      │
│ 👤 Mon compte             │
│ 🚪 Déconnexion            │
└──────────────────────────┘
```

### 5. Sécurité

- Script servi en HTTPS uniquement, CORS strict
  (`Access-Control-Allow-Origin` whitelist : `*.veridian.site`)
- Cookies SameSite=Lax (le switcher peut lire le cookie session Hub via
  `withCredentials: true`)
- CSP `script-src` Hub doit autoriser `https://hub.veridian.site` côté
  CRM/Notifuse/Prospection (à valider à l'injection)
- Pas de leak data utilisateur autre que ses propres apps (auth check au backend)

### 6. Fallback / dégradation

- Si le script Hub est down → pas de switcher visible mais l'app
  fonctionne (failsafe, pas de blocage UI)
- Si l'user n'a pas de session Hub valide → switcher caché (pas de
  pop-up auth intrusive)
- Si JS désactivé → invisible (pas de fallback nécessaire pour ce niveau
  d'UX)

### 7. Versioning

Le script doit avoir un cache busting (`?v=<hash>`) ou un header
`Cache-Control: max-age=300` pour permettre des updates rapides sans
attendre la propagation cache.

## Tests / DoD

- [ ] Test E2E : depuis CRM, click switcher → liste 3 apps → click Notifuse → atterrit dans Notifuse loggué
- [ ] Test E2E : depuis Notifuse, click switcher → click "Découvrir CMS" → redirect /pricing#cms
- [ ] Test unitaire `/api/users/me/apps` : retourne uniquement les apps de l'user (pas leak)
- [ ] Test CORS : origin non-veridian → 403
- [ ] Test performance : script < 8 KB minifié, TTFB < 100ms
- [ ] Test responsive : switcher mobile-friendly (full-screen drawer < 480px)
- [ ] Test accessibilité : navigation clavier + ARIA labels
- [ ] Doc : section "Veridian App Switcher" dans `docs/CROSS-APP.md`

## Non-objectifs

- ❌ SSO complet (vague 6+, c'est un switcher UX, pas un mécanisme auth)
- ❌ Notifications push cross-app (vague 6+)
- ❌ Theming custom du switcher par tenant white-label (vague 5+)
- ❌ Synchroniser le state visuel "current" automatiquement (script lit
  l'URL hostname pour déduire — suffit)
- ❌ Toucher au code Twenty (juste ajout d'un script tag dans le template
  HTML, géré par ticket coordonné dans veridian-crm-repo)
