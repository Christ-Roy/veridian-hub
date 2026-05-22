# UI — Brancher le bandeau trial sur la state machine (retirer le compteur signup)

> **Sévérité** : 🔴 P0 — viole `docs/PRICING-VERIDIAN.md` (interdits côté code)
> **Owner** : agent Hub
> **Créé** : 2026-05-22
> **Refs** : `docs/PRICING-VERIDIAN.md` §"Flow trial complet" + §"Interdits côté code", commit trial state machine 8802f58

## Contexte

La trial state machine a été livrée côté Hub (cron + table, commit 8802f58 — cf
`todo/done/2026-05-21-trial-state-machine.md`). Mais le composant UI qui doit
en être la face visible — `components/dashboard/FreemiumBanner.tsx` — **n'a
jamais été recâblé** : il tourne encore sur l'ancienne logique signup.

État actuel du `FreemiumBanner` (`components/dashboard/FreemiumBanner.tsx`) :

- Il calcule `daysRemaining = 15 - (now - userCreatedAt)` côté client — donc
  le compte à rebours démarre **dès le signup (J0)**.
- Il affiche un **badge compte à rebours** "X jours restants" / "Xh restantes".
- Il affiche une **barre de progression** visuelle (`width: daysRemaining/15 %`).
- Il est rendu pour tout user sans subscription active, **sans condition de
  phase trial**.

C'est une **violation directe** de `docs/PRICING-VERIDIAN.md` :

> ❌ Compteur visible "il vous reste X mails / Y contacts / Y domaines"
> ❌ Affichage du timer trial AVANT J+2 (le délai 2j post-5mails doit rester invisible)
> ✅ Bandeau trial visible UNIQUEMENT en phase 4+ (J+2 après 5 mails)

Le flow correct (doc §"Flow trial complet") :

- **Phase 1-3 (signup → 5e mail → J+2)** : mode silence UI total. AUCUN bandeau,
  AUCUN compteur, AUCUNE deadline visible.
- **Phase 4 (J+2 après 5e mail)** : le bandeau apparaît — "Tu es en essai
  gratuit Pro — il te reste 15 jours pour profiter de tout."
- **Phase 5** : si CB ajoutée → +30j inconditionnels ; sinon → paywall lecture
  seule à J+15 avec lien "Réactiver".

Le bandeau actuel donne donc une deadline anxiogène à un user qui vient de
s'inscrire et n'a encore rien fait — exactement l'effet psychologique que le
design de Robert veut éviter.

## Travail à faire

1. **Source de vérité = la state machine, pas `userCreatedAt`.** Le bandeau ne
   doit plus dériver son état d'une soustraction de dates côté client. Il doit
   consommer l'état trial réel exposé par le Hub (table trial / champ
   `trialEndsAt` + phase). Vérifier ce que le commit 8802f58 a posé en DB et
   exposer un champ "phase trial" propre (idéalement via le `DashboardLayout`
   qui fetch déjà subscription + workspace, ou un endpoint `/api/trial/state`).

2. **Ne rendre le bandeau qu'en phase 4+.** Si l'état trial est `silent`
   (phases 1-3) → `FreemiumBanner` retourne `null`. Le bandeau n'apparaît que
   quand la state machine est passée en phase "trial révélé".

3. **Retirer la barre de progression** (`absolute bottom-0 ... width: %`). Une
   barre qui se vide est un compteur visuel anxiogène — non conforme.

4. **Reformuler le message** selon la phase, en cohérence avec le doc :
   - Phase 4 (trial actif) : "Tu es en essai gratuit Pro — accès complet à tout."
     Le nombre de jours peut rester mais sobre, pas en gros badge rouge.
   - Phase 5 fin de trial proche : message d'invitation à ajouter une CB, ton
     positif ("Ajoute ta carte pour continuer + 30 jours offerts").
   - Phase paywall (J+15 sans CB) : "Ton essai est terminé" + CTA "Réactiver".

5. **Cohérence cross-app** : Prospection affiche déjà un badge "Essai gratuit —
   Xj" (cf `todo/done/2026-05-21-ui-sprint-v14-suite.md` §8). Aligner le ton et
   le placement (le badge sidebar peut venir plus tard, cf ticket sidebar — ce
   ticket-ci se concentre sur le bandeau).

## Fichiers concernés

- `components/dashboard/FreemiumBanner.tsx` — refonte de la logique d'affichage
- `app/dashboard/layout.tsx` — fournit déjà `userCreatedAt` + `hasActiveSubscription` ;
  doit fournir l'état trial réel à la place
- Vérifier l'endpoint / le champ exposé par la state machine (commit 8802f58,
  `lib/` côté trial) — coordination avec l'agent qui a livré 8802f58 si le
  champ phase n'est pas exposable tel quel
- `styles/main.css` — classe `.freemium-banner` si elle reste utilisée

## DoD

- [ ] Un user fraîchement inscrit (phase 1-3) ne voit AUCUN bandeau trial
- [ ] La barre de progression est supprimée
- [ ] Le bandeau n'apparaît qu'en phase 4+ (trial révélé par la state machine)
- [ ] Le message s'adapte à la phase (trial actif / fin proche / paywall)
- [ ] Plus aucun calcul de deadline basé sur `userCreatedAt` côté client
- [ ] Test : le bandeau est `null` tant que la phase trial n'est pas révélée
