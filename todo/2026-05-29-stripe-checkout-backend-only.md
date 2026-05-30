# Stripe checkout 100% backend — supprimer la page HTML /pricing du tunnel

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-05-29

## Contexte

Refonte UI du Hub (sprint DA 2026-05-29) : on veut que le Hub n'expose
**que** des pages légales + le dashboard. Toutes les pages vitrine
(`/`, `/docs`, etc.) redirigent ou sont supprimées au profit de
`veridian.site`.

**Blocage** : la page HTML `app.veridian.site/pricing` ne peut pas être
supprimée car elle est **dans le tunnel de paiement Stripe**.

Flow actuel (vérifié dans `veridian-site-saas-connection/lib/pricing.ts`
`hubCheckoutUrl()`) :

```
veridian.site (clic "S'abonner")
  → app.veridian.site/signup?next=/pricing?plan=X&interval=Y
  → après login, redirect vers /pricing?plan=X
  → la page /pricing (PricingGrid) appelle POST /api/billing/checkout
  → redirect vers l'URL Stripe Checkout
```

La page `/pricing` sert donc à 2 choses : (1) vitrine SEO — **inutile**,
doublon de `veridian.site/plateforme`, jamais indexée par Google
(`unknown_to_google` vérifié via GSC) ; (2) **déclencheur de checkout**
après login — **indispensable** aujourd'hui.

## Objectif

Découpler le checkout de toute page HTML : déclencher Stripe **100% côté
backend**, pour pouvoir supprimer `/pricing` complètement.

## Proposition

Nouvelle route `GET /api/billing/start?plan=<key>&interval=<month|year>` :

1. `requireUser()` — si non loggué, le `?next=` du signup l'amène ici
   après auth (déjà le cas).
2. Valide `plan` / `interval` contre le catalogue `lib/pricing/plans.ts`
   (Zod whitelist — cf `reference_hub_security_audit_2026-05-20`).
3. Plan gratuit → `redirect('/dashboard')`.
4. Plan payant → crée la session Stripe Checkout (réutiliser la logique
   de `POST /api/billing/checkout`) et `redirect(session.url)` (302 vers
   Stripe). Aucune page HTML rendue.

Puis côté `veridian-site-saas-connection/lib/pricing.ts` :

```diff
- const next = `/pricing?plan=${planKey}&interval=${interval}`;
+ const next = `/api/billing/start?plan=${planKey}&interval=${interval}`;
  return `${HUB_URL}/signup?next=${encodeURIComponent(next)}`;
```

→ Cross-app : déposer un ticket miroir dans
`veridian-site-saas-connection/todo/` une fois la route Hub livrée.

## Une fois fait

- Supprimer `app/(marketing)/pricing/page.tsx` + `components/pricing/PricingGrid.tsx`
  (vérifier qu'aucun autre appelant ne reste).
- `GET /api/pricing/plans` (catalogue JSON servi à veridian.site) reste,
  inchangé.
- Webhooks Stripe (`/api/webhooks/*`) restent, inchangés.

## Volet 2 — checkout déclenché depuis les apps downstream (Robert 2026-05-29)

Besoin : qu'une app (Prospection, Notifuse, CRM) puisse ouvrir le checkout
Stripe **sans détour par une page du Hub**, idéalement sans même que
l'utilisateur perçoive de sortie de son app.

État actuel : impossible en l'état. `POST /api/billing/checkout` exige
`requireUser()` (cookie de session Hub) — une app sur son propre domaine
ne l'a pas, et il n'y a pas de CORS. Le seul cookie cross-subdomain
existant (`session-hint-cookie` sur `.veridian.site`) sert à *détecter*
la session, pas à *authentifier* l'API.

**Solution retenue (option A — redirection, validée Robert) :**

La route `GET /api/billing/start?plan=X&interval=Y` (volet 1 ci-dessus)
résout le besoin sans nouveau contrat HMAC :

- L'app fait `window.location = "https://app.veridian.site/api/billing/start?plan=X&interval=Y&return=<url_app>"`.
- Le **navigateur porte le cookie de session Hub** (même utilisateur, SSO
  cross-subdomain déjà en place) → `requireUser()` passe.
- Le Hub crée la session Stripe et redirige (302) vers Stripe Checkout.
- `success_url` / `cancel_url` = le `return` fourni par l'app → après
  paiement, l'utilisateur **revient dans son app**, pas sur le Hub.

→ Ajouter un param `return` (URL de retour) validé en allowlist
(`*.veridian.site` uniquement, anti open-redirect) à `/api/billing/start`.

Option B (HMAC `/api/billing/checkout-for-tenant`, app garde la main sans
redirection) écartée pour l'instant : plus lourde (contrat HMAC), gain
marginal vs la redirection navigateur qui revient sur l'app.

## Mise à jour du contrat (À FAIRE avec la livraison)

Documenter ce flow dans **`CONTRAT-BILLING.md`** (le billing y a été
extrait du `CONTRAT-HUB.md` depuis v1.7) :

- Nouvelle section "Checkout déclenché par une app" : endpoint
  `GET /api/billing/start`, params (`plan`, `interval`, `return`),
  allowlist du `return`, dépendance au cookie SSO cross-subdomain.
- Préciser que les apps **ne signent pas** ce flow (option A) — c'est le
  cookie navigateur qui authentifie, pas un HMAC.
- Mettre à jour le renvoi §7.4 du `CONTRAT-HUB.md` si besoin.

## Garde-fous

- 💀 Touche au flow de paiement → tier CRITIQUE. Tester le checkout réel
  bout-en-bout (E2E Stripe staging) avant promo prod.
- `return` : allowlist stricte `*.veridian.site` (open-redirect = faille).
- Ne PAS supprimer `/pricing` tant que la route backend n'est pas livrée
  ET que `veridian.site` ne pointe pas encore dessus (sinon paiement cassé
  pour les clients venant du site vitrine).
