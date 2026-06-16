# [HUB] 🔵 P3 — `vid` stocké mais jamais utilisé pour la jointure (étage 2 non câblé) : page.hit anonyme et page.hit-avec-vid restent non scorés

> **Sévérité** : 🔵 P3 / **Owner** : agent veridian-hub / **Créé** : 2026-06-17 (audit cohérence réconciliateur)

> ⚠️ **Ce n'est PAS un bug V1** — l'étage 2 (jointure par vid) est explicitement hors périmètre du lot livré. Ticket de SUIVI pour tracer le comportement réel et ce qui reste à câbler.

## Le constat (prouvé)

Le `vid` (ID prospect déterministe cross-app, clé de jointure FORTE cold↔web visée par la spec) est **stocké partout mais utilisé NULLE PART pour joindre/scorer** :

- Stocké sur l'event : `ingest.ts:111` (`vid` dans `prospectEvent.create`).
- Stocké/backfillé sur le score : `ingest.ts:177` (create) et `ingest.ts:188-189` (update : *"Backfill du vid si on l'apprend après coup"*).
- **Jointure du score = 100% email** : `ingest.ts:148-156` `findUnique` sur `workspaceSlug_contactEmail`. C'est la SEULE clé de lookup. `grep` confirme : aucun `findUnique/findFirst/where` sur `vid` dans `lib/prospect/`.

Conséquence de la condition `ingest.ts:138` (`if (points === 0 || !contactEmail) return { scored: false }`) :

| Cas | vid | contact_email | Ingéré ? | Scoré ? |
|---|---|---|---|---|
| email.* avec email | (peu importe) | ✅ | oui | oui (par email) |
| page.hit anonyme | ❌ | ❌ | oui | **non** (pas d'email) |
| page.hit avec vid, sans email | ✅ | ❌ | oui | **non** (le vid ne sauve PAS) |

Le 3e cas est le cœur de la promesse "réconciliation cold↔web" : Analytics voit une visite, propage le `vid` câblé en étage 2, mais **pas d'email** (un visiteur web anonyme n'a pas d'email). Aujourd'hui ce `page.hit{vid}` est ingéré et... ne déplace aucun score. Le `vid` est mort en base.

C'est cohérent avec le code (commentaire ingest.ts:134-136 : *"page.hit sans email ne peut pas être attribué... le vid en étage 2 lèvera ça"*) et la spec (§7.5.4 : *"un page.hit anonyme ne se rattache pas encore à un prospect"*). Mais ça veut dire que **la réconciliation cold↔web, qui est LE besoin métier exprimé par Robert (corréler clic cold + visite web), n'est PAS encore fonctionnelle**. Le V1 livré est un scoreur d'engagement EMAIL, pas un réconciliateur cold↔web.

## Ce qu'il reste à câbler (étage 2)

Dépendances cross-app (hors scope Hub seul, cf SPEC source `notifuse-veridian/todo/2026-06-15-SPEC-...`) :
1. **Identité prospect partagée (vid)** : source Hub, propagée aux prospects (pas que les users).
2. **Notifuse** : poser le `vid` dans les liens `/t/` `/r/`, l'émettre dans les events comportementaux.
3. **Analytics** : capter le `vid` au hit de page, émettre `page.hit{vid}`.
4. **Hub (notre périmètre)** : étendre `ingestProspectEvent` pour joindre **par `vid` en priorité, `contact_email` en fallback** (la spec §7.5.3 le grave : *"vid prioritaire, contact_email fallback"*).

Le point 4 implique côté Hub :
- Une stratégie de jointure à deux clés : si `vid` présent → upsert le score sur une clé incluant `vid` ; sinon `contact_email`. Réconcilier les deux quand on apprend le `vid` d'un prospect connu par email (merge de deux rows `prospect_scores`).
- ⚠️ La clé `@@unique([workspaceSlug, contactEmail])` actuelle ne suffira pas : un event vid-only n'a pas d'email. Migration de clé à prévoir (le schéma anticipe déjà : `vid` dénormalisé + index `prospect_scores_vid_idx`, commentaire schema:905 *"pour la migration future vers une clé (workspaceSlug, vid) sans perte de data"*).
- ⚠️ Aussi : la divergence spec/code sur le `vid` top-level (ticket `2026-06-17-prospect-vid-top-level-divergence-spec-code.md`) doit être réglée d'abord, sinon le `vid` n'arrive même pas jusqu'à l'ingest en v1.4 Bearer.

## Pourquoi 🔵 P3

Étage 2 explicitement reporté (spec §7.5.4 + ticket socle). Le V1 livré fait ce qu'il prétend (scoring email). Ce ticket existe pour que personne ne croie que "réconciliation cold↔web" est livrée : elle ne l'est pas, le `vid` est inerte. À ré-ouvrir quand l'étage 1 (sync tenant fiable, surtout Analytics) sera bouclé.
