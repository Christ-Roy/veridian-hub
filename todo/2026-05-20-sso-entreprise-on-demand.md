# SSO entreprise — note "on demand" (P5)

> **Priorité** : 🟦 P5 (la plus basse). Pas de code en spéculation.
> **Trigger** : remonter en P1 dès qu'un prospect demande SSO en cycle de vente.
> **Estim** : 7-10 jours dev focus quand activé.

## Pourquoi cette note existe

Brainstorm Robert 2026-05-20 : un vrai SSO formel (SAML / OIDC) côté Hub
permettrait à une entreprise cliente d'onboarder l'intégralité de ses
salariés via leur IDP (Okta, Azure AD, Google Workspace, Auth0…) **sans
signup manuel et sans password séparé**.

Décision : on ne code pas tant que pas de prospect concret. Mais on garde
le scope clair pour pouvoir ship "very fast" quand le besoin remonte.

## Ce qui débloquerait le ship

1. **Un prospect entreprise** qui dit "on a Okta / Azure / Google Workspace,
   on veut un login SSO".
2. Validation business : combien de seats, quel plan annuel, quel forfait.
3. À ce moment-là on déterre cette note et on cable.

## Décisions déjà tranchées (au cas où)

### Modèle de billing : **seats inclus + overflow Stripe metered**

- Plan Enterprise = N seats inclus pour X €/mois forfait.
- Overrun automatique en Stripe `metered subscription item` au-delà.
- Définition "user actif" = login dans le mois (pas action métier, pas
  provisionné), avec grâce 30j pour les dormants. Standard industrie.

### Implémentation par couches (du plus rapide au plus complet)

1. **OIDC d'abord** (Google Workspace + Azure Entra ID couvrent 90% des
   prospects). Auth.js v5 a déjà les providers nativement → ~1-2 jours
   par IDP cable.
2. **SAML ensuite** si premier prospect demande Okta classique. ~2 jours
   via `@auth/saml-provider` ou équivalent.
3. **JIT provisioning** par défaut au premier login (pas de SCIM tant
   que pas demandé). Le mapping email-domain → workspace via une table
   `enterprise_domains`.
4. **SCIM endpoint** seulement quand un prospect demande "auto-désactivation
   des employés virés". ~2 jours. `/api/scim/v2/Users` + `Groups`.
5. **Stripe metered subscription_item** + cron `cron-count-active-seats.ts`.
   ~2 jours.

### Coexistence avec l'archi autologin actuelle

L'archi Hub-broker à 3 couches (cf brainstorm 2026-05-20) **ne change pas**.
SSO entreprise est juste un provider de plus dans Auth.js Hub à côté
de Google OAuth et Credentials. Une fois la session Hub établie, les
couches 1/2/3 d'autologin vers les apps fonctionnent à l'identique.

Seule subtilité : mapping `user → workspace` au login se fait par domaine
email (table `enterprise_domains`) au lieu de signup individuel. Les
"groups" remontés par l'IDP peuvent driver le rôle dans le workspace
(`Engineering` → admin, `Marketing` → member, etc.).

## Ce qu'on NE fait PAS tant que pas de demande

- ❌ Provider WorkOS / Auth0 Enterprise (125-240$/mois pour features
  qu'on n'utilisera pas).
- ❌ Pré-câbler SCIM en spéculation (over-engineering).
- ❌ Documentation publique "SSO supporté" dans le pricing (faux signal
  marketing si pas livré).
- ❌ Tickets cross-agent vers Prospection/Notifuse/Analytics/CMS pour
  "supporter SSO". Le SSO est au niveau Hub, les apps continuent à
  recevoir leur session via l'archi autologin actuelle.

## Quand ce ticket remonte

Aux 3 premiers prospects qui demandent SSO : ouvrir cette note, valider
le scope avec eux (OIDC vs SAML, seats, plan), créer un epic P1 dans
`todo/` avec breakdown jour-par-jour, démarrer l'implémentation.

## Liens utiles (pour future référence)

- Brainstorm complet archi 3-couches autologin : conversation Robert
  2026-05-20 (cf transcript Claude).
- Contrat Hub v1.3 : `docs/CONTRAT-HUB.md` (section §9 à créer quand
  on active SSO entreprise — pour l'instant pas dans le contrat).
- Auth.js v5 providers : https://authjs.dev/getting-started/providers
- Standards SAML/OIDC : déjà supportés par tous les IDP majeurs, pas
  de wheel-reinvention nécessaire.
