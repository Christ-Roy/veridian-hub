# [HUB] 🟡 P1 — Presets de scoring configurables (avant d'activer le push CRM)

> **Sévérité** : 🟡 P1 (prérequis produit avant bascule push CRM réelle)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-17 (décision Robert : scoring en standby tant que pas de presets)

## Décision Robert (2026-06-17)
Le scoring tunnel est OPÉRATIONNEL en prod (vérifié : email.clicked → score 30
"chaud", crons automatiques). MAIS Robert veut **NE PAS activer le push CRM**
tout de suite. Avant la bascule réelle, il faut une couche **presets +
configuration avancée customisable PAR PRESET**.

> Robert : "pas de scoring pour l'instant laisse en standby il faudra faire des
> preset et des configuration avancé par preset customisable"

## État actuel (la base est là)
- `lib/prospect/scoring.ts` : interface `ScoringEngine` PLUGGABLE déjà en place
  (`getScoringEngine(id)`, registre `SCORING_ENGINES`, `tunnelScoringEngine`
  id='tunnel-v2' = 1er moteur). Le barème tunnel est EN DUR dans ce moteur.
- Le cron `push-prospect-scores` lit l'engine via ENV `PROSPECT_SCORING_ENGINE_ID`.

## Ce qu'il faut concevoir
Une couche de **presets de scoring configurables** au-dessus de l'engine pluggable :
1. **Modèle de config** : un preset = un jeu de paramètres de barème customisable
   (points par event, caps, fenêtre de récence + multiplicateur, seuils
   froid/tiède/chaud, events disqualifiants, whitelist app_started, etc.).
   Aujourd'hui ces valeurs sont des constantes en dur dans `tunnelScoringEngine`.
2. **Stockage** : table `scoring_presets` (ou JSONB de config par tenant/workspace)
   — à trancher. Multitenant : chaque tenant/campagne peut avoir SON preset.
3. **Engine paramétrable** : `configurableScoringEngine(presetConfig)` qui applique
   un preset au lieu du barème en dur. Le `tunnel-v2` actuel devient le preset
   "défaut".
4. **UI de config** (dashboard) : créer/éditer un preset, ajuster les points,
   prévisualiser le score d'un prospect-type. "Configuration avancée par preset
   customisable" (mot de Robert).
5. **Sélection du preset** par campagne/workspace : quel preset s'applique à quels
   events (routing preset).

## Impact / dépendances
- Bloque l'activation du push CRM (Robert veut les presets d'abord).
- S'appuie sur l'archi DÉCOUPLÉE déjà livrée (events ⟂ scoring, engine pluggable).
- Une fois les presets posés → activer le push CRM (cf
  todo/2026-06-17-activer-push-crm-tunnel-prod.md).

## Non bloquant pour
La campagne email peut tourner SANS (les events s'ingèrent, le scoring tourne avec
le preset défaut tunnel-v2). C'est le PUSH CRM qui attend les presets.

## MAJ 2026-06-17 — le scoring est SORTI du Hub (refactor bus d'events)
Décision Robert affinée : le score ne vit plus dans le Hub du tout (cron + table
prospect_scores + scoring.ts SUPPRIMÉS). Donc les "presets de scoring" ne se
construisent PAS côté Hub — ils se règlent dans le CRM Twenty de chaque tenant
(workflows natifs configurables par workspace). Ce ticket devient : "définir/
documenter comment un tenant règle son scoring dans Twenty (presets de workflow,
seuils, barème) à partir des events que le Hub lui relaie". Le moteur n'est plus
un ScoringEngine TS dans le Hub. Voir todo/2026-06-17-relais-events-temps-reel-vers-crm-tenant.md.
