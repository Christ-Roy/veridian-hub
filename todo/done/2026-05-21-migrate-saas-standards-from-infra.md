# [HUB] Migrer `veridian-infra/docs/saas-standards.md` → `veridian-hub/docs/`

> **Type** : Centralisation docs cross-app
> **Sévérité** : 🟢 P2 (dette doc, pas bloquant immédiat)
> **Owner** : agent Hub
> **Créé** : 2026-05-21 par agent Notifuse
> **Demandeur** : Robert (décision 2026-05-21 — "tout dans Hub, c'est le
> nouveau infra")

## Contexte

`CONTRAT-HUB.md` ligne 11 référence comme **compagnon** :

```markdown
> - `veridian-infra/docs/saas-standards.md` — patterns cross-app (DB, auth, rôles,
>   audit log, soft delete). Ce contrat-ci **n'y duplique rien**, il pointe.
```

Or Robert a tranché : **veridian-infra n'a plus vocation à héberger
la doc cross-app**. Le Hub est désormais le centre des docs partagées
(comme `PRICING-VERIDIAN.md` créé ce matin, ou `CONTRAT-HUB.md` lui-même).

## Action attendue

### 1. Déplacer le fichier

```bash
mv veridian-infra/docs/saas-standards.md veridian-hub/docs/SAAS-STANDARDS.md
```

Convention de nommage : UPPER-KEBAB-CASE comme les autres docs Hub
(CONTRAT-HUB.md, PRICING-VERIDIAN.md, CI-ARCHITECTURE.md, CLAUDE-ROOT.md).

### 2. Mettre à jour toutes les références

Grep cross-platform :
```bash
cd veridian-platform
grep -rn "veridian-infra/docs/saas-standards" --include='*.md'
grep -rn "saas-standards.md" --include='*.md'
```

À jour de tous les pointeurs vers le nouveau chemin
`veridian-hub/docs/SAAS-STANDARDS.md`.

Fichiers déjà connus :
- `veridian-hub/docs/CONTRAT-HUB.md` (ligne 11)
- Probablement d'autres (à grep)

### 3. Vérifier qu'il n'y a pas de duplication

Si `CONTRAT-HUB.md` ou un autre doc Hub couvre déjà les mêmes sujets
(patterns DB, auth, rôles, audit log, soft delete), **consolider** :
- Si le nouveau `SAAS-STANDARDS.md` apporte du contenu unique → garder
  les 2 docs, ajuster les renvois
- Si tout est déjà dans `CONTRAT-HUB.md` → supprimer
  `SAAS-STANDARDS.md` et ne garder que CONTRAT-HUB

### 4. Mettre à jour `CLAUDE-ROOT.md` si nécessaire

S'il y a une référence dans `CLAUDE-ROOT.md` (à grep), idem.

## Hors scope

- Ne pas réécrire les docs (juste déplacer + référencer correctement)
- Ne pas toucher au code (c'est une opération doc pure)

## Plan d'attaque

1. Lire `veridian-infra/docs/saas-standards.md` (combien de pages ?)
2. Lire `veridian-hub/docs/CONTRAT-HUB.md` §"compagnons" et identifier
   les overlaps potentiels
3. Trancher : déplacer tel quel OU consolider dans CONTRAT-HUB
4. Update tous les pointeurs
5. Commit + push staging Hub
6. Notifier Robert + l'agent Infra (qui peut avoir un cleanup à faire
   dans son repo)

## Status

- [ ] Lecture `saas-standards.md` côté Infra
- [ ] Décision : déplacer tel quel ou consolider
- [ ] Move + référence update
- [ ] Grep complet pour pointeurs orphelins
- [ ] Notif Robert + agent Infra
