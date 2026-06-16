# Parcours pricing/checkout depuis la landing veridian.site

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-29 · **Mis à jour** : 2026-05-30
> **Demandé par** : agent veridian-site (branche saas-connection, prod live)

## État actuel (mis à jour 2026-05-30)

Décision Robert : **le pricing/checkout se passe sur `app.veridian.site/dashboard/billing`**
(page authentifiée : grille de plans + clic = Stripe Checkout sans quitter l'espace).
La page `/pricing` marketing du Hub n'est PLUS la destination.

**Côté landing (déjà déployé, rien à attendre de moi)** : `hubCheckoutUrl()` route
désormais les boutons "Choisir ce plan" vers :
- loggué → `app.veridian.site/dashboard/billing`
- non loggué → `app.veridian.site/signup?next=/dashboard/billing`

→ Le parcours fonctionne : le client arrive sur billing, clique son plan, Stripe
s'ouvre. ✅ C'est OK pour l'instant.

## Demandes Hub restantes

### 1. (P1) `/signup` doit respecter `next` quand déjà loggué
`veridian-hub/app/(auth)/signup/page.tsx` : `if (user) redirect('/dashboard')`
ignore le param `next`. Un user déjà loggué qui clique un plan depuis la landing
(via `/signup?next=/dashboard/billing`) atterrit sur `/dashboard` au lieu de
`/dashboard/billing`. **Fix** : `redirect(next ?? '/dashboard')` avec validation
URL interne (anti open-redirect). Idem `/login` si même comportement.
(Note : impact réduit car la landing envoie les loggués DIRECT sur /dashboard/billing,
mais le cas "session expirée entre-temps" retombe sur /signup.)

### 2. (P2, décision Robert) Faire disparaître `/pricing` au profit de la landing
Robert veut que `app.veridian.site/pricing` ne soit plus une page marketing
autonome — le marketing pricing est centralisé sur `veridian.site/plateforme`.
**Demande** : rediriger `app.veridian.site/pricing` → `https://veridian.site/plateforme`
(301). ⚠️ Vérifier d'abord que `/pricing` n'est plus la cible d'aucun lien interne
Hub critique (le checkout réel est sur `/dashboard/billing`, donc a priori OK).
Ne PAS toucher à `/dashboard/billing` (c'est lui le vrai checkout).

## Réponse attendue
Confirmer le fix #1 + arbitrer/implémenter #2 (redirection /pricing → landing) + SHA.
