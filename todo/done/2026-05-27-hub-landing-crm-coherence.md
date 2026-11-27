# [HUB] Cohérence landing : bloc CRM annoncé sans backend dispo

> **Sévérité** : 🔴 P0
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-27
> **Refs** :
> - Audit prod `/tmp/audit-ui-prod-2026-05-27.md` §"À VOIR — CRM" (flag 🔴)
> - Croisement : `docs/PRICING-VERIDIAN.md` ne contient pas de plan CRM, `/pricing` non plus

## Contexte

L'audit prod a mis en évidence une **incohérence marketing/produit** en
prod :

| Surface | État |
|---|---|
| Landing `/` | Vend **explicitement** un bloc "CRM Intelligent" avec features détaillées (contacts, pipeline, kanban, IA) |
| `/pricing` | **Aucun plan CRM** — uniquement Notifuse & Prospection |
| `/terms` (liste sous-apps) | **CRM absent** (mentionne Hub, Notifuse, Prospection, Analytics, CMS) |
| Stack runtime | Twenty fork déployé staging **uniquement**, prod inexistant, 4 tickets CRM en chantier |

Un user qui clique "Commencer gratuitement" depuis le bloc CRM va se
retrouver sur `/signup` puis `/dashboard` sans aucune app CRM provisionnée
→ **friction d'inscription + perte de crédibilité**.

Ce ticket tranche la cohérence : soit **livrer vite** (peu probable
vague 3), soit **retirer/gater** le bloc.

## Action attendue

### Option A — Retirer le bloc CRM de la landing (reco P0, ~1 jour)

Modifier `app/(marketing)/page.tsx` (ou équivalent landing) :
- Section "Nos Services" → **garder uniquement Mail Automation** (Notifuse)
- Ajouter Prospection (déjà en prod) si pas déjà présent
- Le bloc CRM est **commenté** (pas supprimé du repo) avec un TODO clair :
  ```tsx
  {/* TODO: ré-activer ce bloc quand veridian-crm sera GA prod
       (cf todo/2026-05-27-billing-hub-pour-crm.md + dépendances).
       Pour ré-activer, dé-commenter ce bloc ET vérifier que /pricing
       expose un plan CRM. */}
  ```
- Mettre à jour `/terms` pour clarifier que CRM est en beta privée
  (et pas listé comme sous-app GA pour l'instant)

### Option B — Gater le bloc derrière `NEXT_PUBLIC_FEATURE_CRM_PUBLIC` (vague 4 si Robert insiste pour le garder)

Wrapper le bloc CRM dans :

```tsx
{process.env.NEXT_PUBLIC_FEATURE_CRM_PUBLIC === 'true' && (
  <CrmServiceCard />
)}
```

ENV à `false` en prod, `true` en staging. À flip quand v1 dégradé est
prêt à recevoir des signups publics.

### Option C — Marquer comme "Bientôt disponible" (compromis marketing)

Garder le bloc visible mais avec :
- Badge "Bêta" / "Bientôt" en overlay
- CTA "Rejoindre la waitlist" → POST `/api/waitlist` (form email simple,
  notifuse list) au lieu de "Démarrer un essai"
- Mention explicite "Disponibilité prévue Q3 2026"

### Reco à 80% : Option A

Raison : l'option A est la plus honnête envers les visiteurs et la plus
rapide à livrer. Le bloc peut revenir dès que les 4 tickets CRM + ce
plan v1 dégradé sont mergés en prod (estimé 6-8 jours agent séquentiels).

L'option C est un compromis viable si Robert veut capturer des emails
pendant les 2 semaines de dev — à arbitrer avec lui.

L'option B est inutile : si le bloc est invisible en prod, autant le
commenter (option A revient au même résultat utilisateur).

## Action attendue (Option A par défaut)

1. Identifier le fichier landing : `grep -rn "CRM Intelligent" app/`
2. Commenter le bloc avec TODO + référence ticket
3. Vérifier que `/terms` ne mentionne pas CRM dans la liste sous-apps actives
   (si présent : retirer aussi)
4. Aucune migration DB, aucun impact API
5. Commit `[risk:low]` (purement UI marketing, pas de surface fonctionnelle)

## Tests / DoD

- [ ] `curl https://app.veridian.site/` ne mentionne plus "CRM Intelligent"
- [ ] `/pricing` reste inchangé (déjà sans CRM)
- [ ] `/terms` ne liste plus CRM dans sous-apps (sauf si déjà retiré)
- [ ] Snapshot test `app/(marketing)/page.test.tsx` updated (si existe)
- [ ] Commit message : `chore(landing): hide CRM block until v1 ships [risk:low]`

## Si Robert demande l'Option C (waitlist)

Spec rapide :
- Endpoint `POST /api/crm-waitlist` : `{email}` validation Zod → INSERT
  dans `crm_waitlist` (nouvelle table simple : `id, email UNIQUE, created_at`)
- Confirmation Notifuse mail "Vous êtes sur la liste, on vous prévient
  dès l'ouverture"
- CTA landing remplacé : "Rejoindre la waitlist" au lieu de "Démarrer
  l'essai"
- Migration Prisma + tests E2E + rate-limit (30/h/IP)

## Non-objectifs

- ❌ Bloquer la sortie CRM sur ce ticket (priorité opposée : on retire
  pour ne pas attendre)
- ❌ Refondre toute la landing (juste le bloc CRM)
- ❌ Décider de l'offre commerciale CRM (déjà couvert par
  `todo/2026-05-27-review-offre-crm-veridian.md`)
