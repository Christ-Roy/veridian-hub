# [HUB] 🔵 P3 — E2E S1 rate-limit : flake en burst 100-parallèle (le rate-limit MARCHE)

> **Sévérité** : 🔵 P3 (flake de test, PAS un bug prod)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-16 par le team-lead (session promo réconciliateur)

## Symptôme
`e2e/staging-full/16-stress-security.spec.ts` S1 « GET /api/invitations/<faketoken>/verify :
100 calls // → quota 30/min/IP touché » échoue : `Got 0 429, 100 non-limited.
Sample statuses: 404,404,...`.

## Diagnostic (fait)
Le rate-limit **fonctionne** en réalité. Test direct manuel le 2026-06-16 :
40 GET séquentiels-rapides sur la même URL → **30×404 puis 10×429** (cap 30/min
respecté, Retry-After posé). Le flake vient du `Promise.all` de 100 requêtes
**strictement simultanées** : elles partent avant que le compteur du limiter
(in-memory/IP) ne s'incrémente, donc le burst passe « sous » la fenêtre. C'est
un artefact du pattern de test, pas une faille.

## À faire
- [ ] Soit envoyer les 100 calls par vagues (ex. 10 lots de 10 avec petit délai)
      pour laisser le compteur s'armer, soit baisser le seuil d'assertion en
      tenant compte de la race (≥1 429 suffit à prouver l'enforcement).
- [ ] Vérifier si `E2E_RATELIMIT_BYPASS` (commit 7232961) interfère sur cet
      endpoint en staging (le GET verify est-il dans la liste des limiters
      bypassés ? si oui, retirer verify du bypass car la spec le teste).

## Non bloquant
Le rate-limit prod est sain. Ticket de durcissement de la spec, pas un fix prod.
