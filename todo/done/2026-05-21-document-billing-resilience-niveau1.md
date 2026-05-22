# 2026-05-21 — Documenter §1.4bis "Billing résilience" dans CONTRAT-HUB

> **Type** : Doc contrat cross-app
> **Sévérité** : 🟢 P3 (cosmétique, le code est shippé)
> **Owner** : agent Hub
> **Créé par** : agent Notifuse (lot H résilience billing)
> **Spec parent** : CONTRAT-HUB §1.4 (gravé 2026-05-21)

## Contexte

Notifuse a shippé le **lot H résilience billing niveau 1** (commit à venir
côté `notifuse-veridian/veridian`). Cohérent avec la règle gravée §1.4
"Hub source de vérité + résilience apps".

**Mécanisme implémenté côté Notifuse** :

- Migration V39 ajoute `veridian_plan.last_hub_sync_at TIMESTAMPTZ`
- Mise à jour du timestamp à chaque mutation Hub→Notifuse (10 méthodes :
  Provision, UpdatePlan, Suspend, Resume, SoftDelete, Restore, Touch,
  AttachOwner, AttachMember, GrantUnlimited)
- Middleware paywall évalue la fraîcheur du lien :
  - **Fresh** (< 24h) : mode normal
  - **Stale** (24-72h) : grace period optimistic, log warn rate-limit
  - **Dead** (> 72h) : writes bloqués 503 + `Retry-After: 3600`,
    `error_code=hub_sync_dead`. Reads passent (best-effort).
- **Soft-deleted prime sur HubSyncDead** (UX cohérent)
- Routes admin Hub `/api/veridian/*` exemptées (Hub doit pouvoir réveiller)

## Action demandée côté Hub

Ajouter une section §1.4bis "Billing résilience niveau 1" dans
`CONTRAT-HUB.md` qui documente :

1. **Le mécanisme** : Notifuse mesure la fraîcheur du push Hub→app via
   `last_hub_sync_at` updaté à chaque mutation HMAC.
2. **Les 3 phases** : Fresh / Stale / Dead avec seuils 24h / 72h.
3. **Code erreur partagé** : `hub_sync_dead` (réponse 503 + Retry-After).
4. **Le pattern réplicable** : cette approche peut être étendue à
   Prospection, Analytics, CMS pour résilience cross-app symétrique.
5. **Limites** : niveau 1 = cache plan local. Si Stripe webhook arrive
   sur Hub down → Notifuse ne sait pas. Niveau 2 (Stripe direct check
   côté app) explicitement déprio par Robert 2026-05-21 ("over-engineering
   pour le stade actuel, à revoir à 10+ clients payants").

## Référence code

- Migration : `notifuse-veridian/internal/migrations/v39.go`
- Domain : `notifuse-veridian/internal/domain/veridian.go` —
  `HubSyncStatus`, `EvaluateHubSyncStatus`, seuils `HubSyncFreshThreshold`
  / `HubSyncDeadThreshold`
- Middleware : `notifuse-veridian/internal/http/middleware/veridian_paywall.go`
- Tests : 30+ tests colocalisés Constitution §1

## Effort

~30 min de doc CONTRAT-HUB. Pas de code à shipper côté Hub.

## Critère de complétion

- [ ] §1.4bis ajouté dans `veridian-hub/docs/CONTRAT-HUB.md`
- [ ] Mention dans changelog v1.5 (déjà gravé) ou bump v1.6
- [ ] Ticket archivé dans `veridian-hub/todo/done/`
