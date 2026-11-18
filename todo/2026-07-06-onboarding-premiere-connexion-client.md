# [HUB] Onboarding client : pas de flow de PREMIÈRE connexion self-service (le CLI doit générer un lien d'accès durable)

> **Sévérité** : 🔴 P1 (bloque toute livraison client propre — on ne peut pas mettre un lien fiable dans un mail)
> **Owner** : agent veridian-hub
> **Créé** : 2026-07-06 par agent (demande Robert, incident démo Céline Gaetan)

## Le problème de fond (mots de Robert)
« Le CLI devrait générer lui-même des URL d'invitation pour les mettre dans les mails,
c'est pas sérieux, normalement ils devraient avoir accès directement. »

Un client provisionné par admin (`hub users:create` + `hub link`) **n'a AUCUN moyen de se
connecter seul** :
- Login Hub = `signIn('credentials', {email, password})` (bcrypt dans `accounts.access_token`)
  → le client n'a pas de mot de passe.
- Pas de magic-link email dans `LoginForm` (uniquement credentials + OAuth Google).
- `/api/invitations/create` existe MAIS : (a) auth HMAC `HUB_INVITATION_SECRET_<APP>` **absent
  des env prod** (non configuré), (b) `/api/invitations/[token]/accept` **exige déjà une session
  Hub** (circulaire : l'invitation ne connecte pas, elle lie une app à un compte déjà loggé).
- `hub open` / `impersonate` = magic link **admin-only**, usage unique, TTL 10 min → inutilisable
  dans un mail (périmé/consommé avant que le client clique).

Résultat : les magic-links autologin sont **tous éphémères** → impossible d'en coller un dans un
mail. Et les URLs directes (`prospection.app.veridian.site`...) tombent sur login.

## Ce qu'il faut (proposition)
Une commande CLI **`hub invite <email> [--apps notifuse,prospection]`** qui génère un **lien
d'onboarding DURABLE** (7-30j) à coller dans un mail. Au clic, le client :
1. atterrit sur une page `/onboard/<token>` (publique, pas de session requise),
2. définit son mot de passe (ou se connecte via Google),
3. est loggé dans le Hub + a accès à ses apps liées.

Techniquement : réutiliser/étendre le mécanisme `verification_tokens` + une page set-password
publique. Alternative : activer un provider **magic-link email** (Resend est déjà branché pour
les autres mails) dans `LoginForm` → le client tape son email, reçoit un lien. Le plus simple à
livrer, et durable par nature (le client déclenche le lien à la demande).

## Contournement appliqué (2026-07-06, démo Céline)
Créé à la main un `account` credentials (bcrypt) pour Céline en base
(`INSERT INTO hub_app.accounts ... provider='credentials'`), mot de passe provisoire communiqué
dans le mail. Login vérifié en prod (POST `/api/auth/callback/credentials` → 302 `/dashboard` +
cookie session posé). **Ça marche mais c'est manuel et pas scalable** — d'où ce ticket.

## Impact
Tant que ce flow n'existe pas, chaque livraison client nécessite une manip DB manuelle + un mot
de passe en clair dans un mail. Non tenable pour un SaaS.
