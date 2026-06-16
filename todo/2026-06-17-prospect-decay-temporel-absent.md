# [HUB] 🔵 P3 — Score d'engagement sans decay temporel : un prospect chaud reste chaud pour toujours

> **Sévérité** : 🔵 P3 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

> ⚠️ **Ce n'est PAS un bug** — c'est une limite de conception ASSUMÉE par le code et la spec ("feature post-volume"). Ticket de SUIVI pour ne pas l'oublier quand le volume arrivera.

## Le constat (prouvé)

Le barème est purement **additif et borné par event, sans pondération temporelle** :

- `lib/prospect/scoring.ts:18-19` (commentaire) : *"Le barème est volontairement additif et borné par event ; pas de pondération temporelle au V1 (decay = feature post-volume)."*
- `docs/CONTRAT-HUB.md §7.5.3` : *"Additif, borné par event, sans decay temporel (feature post-volume)."*
- `lib/prospect/ingest.ts:185` — `engagementScore: { increment: points }` : le score ne fait QUE monter. Aucun code ne le décrémente ni ne le recalcule en fonction de l'âge des events.

## Conséquence (quand il y aura du volume)

Un prospect qui a répondu (+20) il y a 6 mois et n'a plus rien fait depuis reste à **20 pts**, à égalité avec un prospect qui a répondu hier. La priorisation CRM ("prioriser les chauds") devient fausse dans le temps : on remonte des prospects froids comme s'ils étaient chauds. `last_event_at` est stocké (`prospect_scores.last_event_at`) mais **jamais utilisé pour pondérer** — il sert juste d'horodatage.

## Pistes (post-volume, pas maintenant)

- **Half-life decay** : score effectif = `SUM(points_i * 0.5^(age_i / half_life))`, recalculé à la lecture (ou par un cron de recompute). `last_event_at` + une timeline par event (`prospect_events` est déjà append-only et indexé `(vid, occurred_at DESC)`) donnent tout le matériel.
- **Score de fenêtre glissante** : ne compter que les events des N derniers jours.
- **Champ `score_decayed` calculé** vs `engagement_score` brut, pour garder l'historique.

La table `prospect_events` conserve déjà chaque event avec `occurred_at` → le recompute avec decay est faisable a posteriori sans perte de données. Rien à migrer en urgence.

## Pourquoi 🔵 P3 et pas un bug

Décision explicite figée par le lead 2026-06-15 (cité dans le code et le contrat). Le V1 est volontairement simple. À ré-ouvrir **quand** le volume + le besoin de priorisation fine se matérialisent (un émetteur réel branché + assez de prospects pour que la fraîcheur compte). Pas avant.
