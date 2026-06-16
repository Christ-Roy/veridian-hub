# [HUB] 🐛 P2 — Race findUnique/upsert : `signals` diverge du `engagement_score` sous concurrence

> **Sévérité** : 🟢 P2 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

## Le trou (prouvé)

Le score est mis à jour en deux temps non atomiques :

1. `lib/prospect/ingest.ts:148-156` — `findUnique` lit les `signals` actuels.
2. `lib/prospect/ingest.ts:157-160` — `bumpSignals(existing.signals, eventType)` calcule la nouvelle map EN MÉMOIRE (read-modify-write applicatif).
3. `lib/prospect/ingest.ts:167-192` — `upsert` écrit :
   - `engagementScore: { increment: points }` → **increment atomique côté DB** (juste).
   - `signals: nextSignals` → **OVERWRITE complet** de la map (PAS un increment atomique).

Le commentaire ingest.ts:142-147 reconnaît la course mais la sous-estime : *"le pire = un signal légèrement sous-compté, le score reste juste"*. Faux sur la divergence.

## Pourquoi la conséquence est plus large que "sous-compté"

Score existant `{ opened: 5 }`, engagementScore=5. Deux `email.opened` concurrents A et B :

| Étape | A | B | Score DB | signals DB |
|---|---|---|---|---|
| findUnique | lit `{opened:5}` | | 5 | `{opened:5}` |
| findUnique | | lit `{opened:5}` | 5 | `{opened:5}` |
| A upsert | increment+1, signals=`{opened:6}` | | 6 | `{opened:6}` |
| B upsert | | increment+1, signals=`{opened:6}` | 7 | `{opened:6}` |

Résultat : **`engagement_score = 7` mais `signals.opened = 6`**. Le score et les signals sont **désynchronisés** : `signals` ne somme plus jamais au score.

C'est un défaut de cohérence, pas juste un undercount : la migration `20260615120000` justifie explicitement la colonne `signals` par *"pour expliquer le score sans relire tous les events"*. Si `signals` ne reflète plus le score, **l'explicabilité du score (sa raison d'être) est cassée**. Un dashboard qui affiche "ce prospect : 6 ouvertures, 0 clic → score 7" est incohérent et mine la confiance dans la priorisation.

## Fix attendu (voie propre)

Deux options, par ordre de préférence :

- **A (recommandé)** : stocker les compteurs `signals` comme **colonnes/champs incrémentables atomiquement** plutôt qu'une map JSONB overwritée. Soit en éclatant en colonnes `signal_opened/clicked/replied/page_hit INT` (increment atomique Prisma), soit via un `UPDATE ... SET signals = jsonb_set(signals, ...)` SQL atomique. Supprime le read-modify-write applicatif entièrement.
- **B (minimal)** : envelopper `findUnique` + `upsert` dans la **même `$transaction` `SERIALIZABLE`** (lié au ticket atomicité event/score `2026-06-17-prospect-ingest-non-atomique-event-score.md` — le faire en un seul fix cohérent). Coût : retries sur conflit de sérialisation.

## Sévérité

🟢 P2 : impact business faible (le score numérique reste à peu près juste via l'increment atomique ; seule la ventilation par type dérive), et invisible tant qu'il n'y a pas de volume concurrent réel sur un même `(workspace, email)`. Mais c'est un vrai défaut de conception à corriger en même temps que le ticket atomicité (même cause racine : read-modify-write applicatif hors transaction). Ne PAS shipper l'explicabilité du score dans un dashboard sans avoir réglé ça.
