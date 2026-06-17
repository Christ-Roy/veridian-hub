# [HUB] 🟡 P1 — Relais des events temps réel vers le CRM du tenant (remplace le cron)

> **Sévérité** : 🟡 P1 (archi cible du bus d'events — remplace le cron supprimé)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (décision Robert : Hub = bus d'events, score dans le CRM)

## Décision Robert (2026-06-17)
Le Hub est un BUS D'EVENTS. Le scoring centralisé a été SUPPRIMÉ (cron horaire +
table prospect_scores + barème en dur, commit refactor bus). Le score ne vit plus
dans le Hub : il se règle dans le CRM Twenty de chaque tenant (par workspace,
workflows natifs). Robert : "le score est cosmétique et devrait être réglable dans
les workspace CRM de chaque tenant".

## Ce qu'il faut construire
À la place du cron horaire (latence de clochard), le Hub doit RELAYER chaque event
en TEMPS RÉEL vers le CRM du tenant concerné :
1. **Déclenchement temps réel** : à l'ingestion d'un event (`ingestProspectEvent`)
   OU via un petit worker/queue async juste après — PAS un cron horaire. Latence
   cible : quelques secondes, pas 0-60 min.
2. **Relais vers le CRM** : pousser l'event comme **timeline activity** dans le
   Twenty du tenant (réutiliser `lib/crm/client.ts` `batchTimeline` qui existe).
   Resolve Person (email→primaryEmail). Le CRM applique SON scoring (workflows
   natifs configurables par le tenant) sur les events reçus.
3. **Routage tenant** : event.workspace_slug → Tenant → CrmTenant → twentyWorkspaceUrl
   + clé. Si pas de CrmTenant → skip gracieux (rien à pousser).
4. **Idempotence du relais** : ne pas re-pousser un event déjà relayé (marqueur
   `crm_relayed_at` sur prospect_events, ou dédup par idempotency_key côté Twenty).
5. **Robustesse** : le relais NE DOIT JAMAIS bloquer/casser l'ingestion (best-effort
   async). Un CRM down = l'event reste persisté dans le bus, relayé au retry.

## Pré-requis (bloquants aujourd'hui)
- **0 CrmTenant actif** en prod → le relais ne pousse nulle part tant qu'un tenant
  n'a pas de CRM connecté. Cf todo/2026-06-17-activer-push-crm-tunnel-prod.md.
- **Scoring côté CRM** : définir comment le tenant règle son scoring dans Twenty
  (workflows natifs + presets). Cf todo/2026-06-17-presets-scoring-configurables.

## Ce qui est DÉJÀ fait
- Le bus d'events : ingestion temps réel, idempotente, 2 voies (Notifuse + Analytics).
- `lib/crm/client.ts` : batchTimeline + resolve Person + DRY_RUN (la couche write).
- prospect_events : la donnée brute, source de vérité.

## Garde-fou
Tant que ce relais n'est pas livré ET qu'aucun CrmTenant n'existe, le Hub
PERSISTE les events (visibles en DB `prospect_events`) mais ne pousse rien au CRM.
Le bus fonctionne, le relais est l'étage suivant.
