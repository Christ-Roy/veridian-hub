# [HUB] Cabler le maillage docs/PRICING-VERIDIAN.md → CLAUDE-ROOT.md + CLAUDE.md Hub

> **Type** : Doc + maillage cross-app
> **Sévérité** : 🟢 P3 (qualité de vie agents, pas bloquant)
> **Owner** : agent Hub
> **Créé** : 2026-05-21 par agent Notifuse
> **Effort** : 10-20 min

## Contexte

L'agent Notifuse a créé `veridian-hub/docs/PRICING-VERIDIAN.md` ce
matin (2026-05-21) comme **source de vérité unique cross-app** sur le
pricing, le trial flow, et les responsabilités Stripe/Hub/apps.

Le doc est complet (~250 lignes) et déjà mailé vers :
- `notifuse-veridian/CLAUDE.md` (fait par l'agent Notifuse)
- Memory `project_pricing_pivot_2026_05_21.md` (Notifuse)
- Tous les tickets actifs côté Notifuse + tickets Hub posés

**Reste à câbler côté Hub** :

## Demandes

### 1. Lire le doc et valider l'archi proposée

L'agent Hub doit lire `veridian-hub/docs/PRICING-VERIDIAN.md` et :

- Valider ou amender la philosophie pricing (Robert a déjà tranché,
  donc relecture cohérence vs. l'existant Hub)
- Valider la séparation des responsabilités (Stripe→Hub→apps, pas
  Stripe→app direct)
- Identifier toute incohérence avec le code Hub actuel (ex: si le
  Hub a déjà un endpoint Stripe webhook partiellement câblé qui
  contredirait le nouveau ticket)

### 2. Cabler le maillage interne CLAUDE-ROOT.md

`CLAUDE-ROOT.md` (= symlink `veridian-platform/CLAUDE.md`) doit
pointer vers `PRICING-VERIDIAN.md` dans une section dédiée pricing,
pour que tous les agents y arrivent automatiquement.

Suggestion d'ajout dans `CLAUDE-ROOT.md` (après la section "Vision
cible — harmonie cross-app", avant "Flow standard : un agent par app") :

```markdown
## 💰 Pricing & trial cross-app

**Source de vérité unique** : `veridian-hub/docs/PRICING-VERIDIAN.md`.

Tout agent qui touche au pricing, paywall, trial, branding, custom
domains, limites de plan, webhooks Stripe DOIT lire ce fichier avant
d'agir. Il définit :

- La **grille de prix** (Free / Pro 29€ / Business 99€ / Enterprise)
- Le **flow trial complet** (5 mails → 2j silence → 15j visible → +30j
  si CB → débit ou paywall)
- Les **responsabilités cross-app** : Stripe → Hub → apps (PAS Stripe
  → app directement)
- Les **interdits côté code** (pas de mur béton, pas de compteur
  visible, pas de menu grisé)

**Philosophie figée par Robert 2026-05-21** : générosité maximale.
Tout illimité partout. SEULES différenciations = durée Free 15j +
white-label Business+. L'app ne doit JAMAIS être défigurée par des
limites visibles.
```

Mettre aussi à jour la bullet `⏳ **Stripe trial intelligent**` de la
section "Vision cible" pour pointer vers le doc + lister les tickets
actifs (cf. notifuse-veridian/CLAUDE.md pour la formulation exacte).

### 3. Mailler vers le doc depuis le `CLAUDE.md` Hub local

`veridian-hub/CLAUDE.md` (local Hub, distinct de CLAUDE-ROOT.md)
doit avoir une section pricing qui pointe vers le doc, similaire à
ce qu'a fait l'agent Notifuse dans son propre `CLAUDE.md`.

### 4. Compléter la section "Implémentations actuelles" du doc

Quand l'agent Hub aura commencé à implémenter :
- `2026-05-21-stripe-webhook-orchestrator.md`
- `2026-05-21-trial-state-machine.md`

Il doit mettre à jour `veridian-hub/docs/PRICING-VERIDIAN.md` §
"Implémentations actuelles" pour refléter l'état réel (vs. l'état
"non-implémenté" décrit actuellement).

## Hors scope

Ne pas :
- Toucher au code applicatif Hub (les tickets dédiés s'en chargent)
- Modifier `notifuse-veridian/CLAUDE.md` (l'agent Notifuse l'a déjà fait)
- Modifier le doc PRICING-VERIDIAN.md sans accord de Robert (c'est
  la source de vérité figée). En revanche, AJOUTER une section
  "Implémentations actuelles — Hub" est légitime.

## Plan d'attaque suggéré

1. Lire `veridian-hub/docs/PRICING-VERIDIAN.md` en entier
2. Valider l'archi ou rédiger une réponse-amendement si désaccord
3. Editer `CLAUDE-ROOT.md` (section pricing + bullet Stripe trial)
4. Editer `veridian-hub/CLAUDE.md` (pointeur vers doc)
5. Commit + push sur staging Hub

## Status

- [ ] Doc lu et validé (ou amendé)
- [ ] `CLAUDE-ROOT.md` édité
- [ ] `veridian-hub/CLAUDE.md` édité
- [ ] Notification à Robert pour signaler le maillage en place
