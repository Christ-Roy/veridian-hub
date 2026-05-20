# [HUB] Stratégie de synchronisation tenants cross-app (3 niveaux)

> **Type** : Décision d'architecture long terme
> **Sévérité** : 🟡 P2 — vision cible
> **Owner** : agent Hub (lead) + tous les agents apps
> **Créé** : 2026-05-20

## Le problème

L'écosystème Veridian a 4 apps SaaS (Notifuse, Prospection, CMS, Analytics)
+ le Hub orchestrateur. Chaque app gère son propre état de tenant. Le Hub
agrège pour l'UI dashboard.

**Désynchronisation possible** à plusieurs moments :
- Robert provisionne via skill manuel → Hub pas informé
- Un agent fait un INSERT SQL sur une app downstream → Hub pas informé
- Un user delete son compte côté app → Hub garde la card
- Un workspace est suspendu (billing) côté app → Hub affiche actif
- Migration DB qui orpheline un user

**Vision Robert** : "à terme avoir cette harmonie entre les apps où elle
s'auto-découvre et avoir une solution pour que les tenants soient
synchronisés."

## 3 niveaux de sync — pattern incrémental

### Niveau 1 — Discovery pull (ticket existant)

Le Hub interroge les apps **au login** via `GET /api/users/by-email`.
Pas de stockage côté Hub, pas de désync possible — mais latence à chaque
login + dépendance sur la disponibilité des apps.

→ Spec dans `todo/2026-05-20-hub-discovery-by-email-pattern.md`

**Avantages** :
- Source de vérité unique côté chaque app
- Aucune désync possible
- Pas de migration Hub à chaque nouvelle app

**Limites** :
- Latence N × HTTP au login (N = nombre d'apps)
- Si une app est down → carte cachée silencieusement
- Pas de notification proactive (Hub découvre les changements seulement au login)

### Niveau 2 — Webhook push (notification temps réel)

En complément du Niveau 1, chaque app **notifie le Hub** quand son state
change via webhook. Hub maintient un cache local à jour en temps réel.

```
App → Hub : POST /api/webhooks/<app> avec event
  - tenant.created     → Hub maj cache, push notif au user
  - tenant.suspended   → Hub désactive la card côté UI
  - tenant.resumed     → Hub réactive
  - tenant.deleted     → Hub retire la card + envoie email confirmation
  - tenant.owner_changed
  - tenant.member_added / member_removed
  - plan_changed       → Hub sync Stripe customer si applicable
```

Déjà partiellement spec dans `CONTRAT-HUB.md` §3 (webhooks app → Hub).
Reste à étendre :
- Format Cloud Events standard (https://cloudevents.io/)
- Retry avec backoff exponentiel + dead letter queue
- Idempotence côté Hub (déduplication sur `idempotency_key` sur 24h)
- Signature HMAC pour chaque webhook (pas juste token statique)

**Avantages** :
- Cache toujours frais (pas d'attente du login user)
- Hub peut alerter (email, push) sur événement critique
- Permet l'observabilité (audit log events cross-app)

**Limites** :
- Demande implémentation côté chaque app + Hub
- Risque de désync si webhook perdu (mitigé par réconciliation, voir Niveau 3)

### Niveau 3 — Réconciliation périodique (filet de sécurité)

Cron Hub qui exécute `discoverUserApps` pour **tous les users actifs**
hebdomadairement et **compare** au cache local. Si désync détectée :
- Auto-repair (cache mis à jour avec la valeur app downstream)
- Log alerte côté observabilité (`reconciliation_drift`)
- Si drift répétitif sur un user → ticket auto-créé `todo/`

Pattern standard "outbox + reconciliation" — c'est ce que fait Stripe Connect
pour sync les comptes vendeurs.

```bash
# Cron Hub
0 3 * * 0  # Dimanche 3h UTC
  → cron-reconcile-tenants.ts
    → for each active user :
        actual = discoverUserApps(user.email)
        cached = hub.tenants.metadata
        if actual ≠ cached :
            log warning
            update cached
            count_drift++
    → after all : send report Telegram if drift > N
```

**Avantages** :
- Détecte les bugs de webhooks (event perdu, app dropped)
- Maintient la cohérence long terme même si Niveaux 1+2 ont des trous
- Génère des metrics observabilité (`drift_rate`, `apps_down_rate`)

## Roadmap d'implémentation conseillée

### Sprint 1 (semaine 1-2) — Niveau 1 base
- Endpoint `GET /api/users/by-email` sur CHAQUE app (4 PRs cross-app)
- Service `lib/hub/discoverUserApps.ts` côté Hub
- Cache Redis 5 min
- UI dashboard utilise discovery

### Sprint 2 (semaine 3-4) — Niveau 2 webhooks
- Étendre `CONTRAT-HUB.md` §3 avec format Cloud Events
- Chaque app : implémenter outbox + delivery garanti
- Hub : endpoint `POST /api/webhooks/<app>` avec verify HMAC + dedup

### Sprint 3 (semaine 5-6) — Niveau 3 reconciliation
- Cron Hub `cron-reconcile-tenants.ts`
- Dashboard admin "Drift detected" pour Robert
- Auto-repair par défaut

### Sprint 4 — Polish + obs
- Metrics Grafana : `tenant_discovery_latency`, `webhook_received_total`,
  `reconciliation_drift_count`
- Alerts : si une app downstream est down > 5 min, désactiver
  silencieusement ses cards (mode dégradé gracieux)

## Décision tranchée par Robert (à valider)

1. **Niveaux 1+2+3** comme cible long terme (4-6 semaines polyrepo) ?
2. **Quel niveau attaque-t-on en premier** ?
   - Recommandation : Niveau 1 d'abord (utile immédiatement pour AVSE et
     futurs clients service)
3. **Format event** : Cloud Events ou format Veridian maison (cohérence avec
   le contrat HMAC existant) ?

## Référence

- `todo/2026-05-20-hub-discovery-by-email-pattern.md`
- `todo/2026-05-20-admin-api-tenant-provisioning.md`
- `CONTRAT-HUB.md` §3 (webhooks app → Hub)
- Pattern "outbox + reconciliation" : https://microservices.io/patterns/data/transactional-outbox.html
- Stripe Connect sync pattern (référence implémentation)
