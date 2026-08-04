---
paths:
  - "**/*"
---

# Architecture SaaS

- Chaque app a son propre auth. Pas de dependance a Supabase pour les apps.
- Stripe est la source de verite pour l'etat des tenants (plan, limites, actif/suspendu).
- Les apps sont des blocs independants. Ajouter/retirer une app ne casse pas le reste.
- Le hub est leger : signup + billing + provisioning. Pas de logique metier.
- Infrastructure : cluster HashiCorp Nomad (control-plane bastion Contabo) + OVH VPS. Pas de Kubernetes. (Ex Docker compose + Dokploy, décommissionné 2026-07-10 ; pilotage `nomad-v` / skill `/nomad`.)
- JAMAIS modifier la prod sans accord de Robert.
- Toujours penser aux tenants existants avant toute migration DB.
- Lire todo/TODO-LIVE.md pour le backlog priorise.
