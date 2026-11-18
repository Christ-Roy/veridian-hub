# [HUB] 🟡 P1 — Brancher Analytics-engine au broker SSO autologin (Couche 1 contrat Hub)

> **Sévérité** : 🟡 P1
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-22
> **Demandeur** : Robert (via agent analytics-engine)

## Demande

Permettre l'**autologin Hub → Analytics** : depuis le Hub (`app.veridian.site`),
quand l'utilisateur clique « Open Analytics » sur la card du service, il doit
arriver connecté sur `analytics-engine.app.veridian.site` **sans re-saisir**
email/password.

C'est la **Couche 1 (Hub broker)** du contrat SSO (`CONTRAT-HUB.md §6bis.1`) :
le Hub appelle l'app cible en HMAC §6.1 → l'app génère son token autologin local
→ Hub redirige l'user vers `/auth/token?t=<token>` qui pose la session app.

## Ce qui est livré côté Analytics-engine (ou en cours — voir ticket engine)

L'engine expose (ou va exposer, cf ticket engine
`veridian-analytics-engine/todo/2026-06-22-sso-autologin-hub-issue-token.md`) :
- `POST /api/sso/issue-token` — authentifié **HMAC `HUB_HMAC_SECRET`** (partagé
  Hub↔engine, déjà dans l'ENV Dokploy engine prod). Body `{email}` (ou
  `{hub_user_id, email}`). Renvoie `{ autologin_url }` ou `{ token }` (TTL court,
  ~5 min, usage unique).
- `GET /auth/token?t=<token>` — consomme le token, pose le cookie/session engine,
  redirige vers le dashboard.

## À faire côté Hub

1. Dans le client Analytics du Hub (`lib/analytics/client.ts`), ajouter une
   fonction `issueAnalyticsAutologin(email)` qui appelle
   `POST analytics-engine.app.veridian.site/api/sso/issue-token` en signant HMAC
   §6.1 (même mécanisme que les autres apps : Notifuse/Prospection).
2. Sur le clic « Open Analytics » de la card service (dashboard Hub) : appeler
   cette fonction server-side, récupérer l'`autologin_url`, et faire un `302`
   vers celle-ci (au lieu d'ouvrir bêtement l'URL de login).
3. Vérifier que la card Analytics est bien « active » pour le tenant (le user a
   un workspace analytics provisionné) avant de proposer le bouton.

## Notes
- Le workspace analytics de Robert = `vrd_veridian_site_prod`, user owner
  `robert.brunon@veridian.site` (créé 2026-06-22, super_admin).
- Le contrat complet : `CONTRAT-HUB.md §6bis` (4 couches dégradées). Ici on ne
  câble que la Couche 1 (broker). Les couches 2-4 (cookie cross-subdomain,
  magic-link mail, bounce OAuth) sont des évolutions ultérieures.
- HMAC : réutiliser le mécanisme §6.1 déjà en place pour Notifuse/Prospection
  (timestamp + signature, anti-replay). Le secret `HUB_HMAC_SECRET` est déjà
  partagé (présent dans l'ENV engine prod).
