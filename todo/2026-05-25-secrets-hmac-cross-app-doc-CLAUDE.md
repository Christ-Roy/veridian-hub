# Doc CLAUDE.md Hub — matrice des secrets HMAC cross-app (vue Hub-side)

> **Sévérité** : 🟢 P3 — doc/onboarding, gain de temps agent
> **Owner** : agent Hub
> **Créé** : 2026-05-25 (déposé par agent Notifuse, miroir du ticket
> Notifuse `2026-05-24-secrets-hmac-cross-app-doc-CLAUDE.md` shippé)

## Contexte

L'agent Notifuse a ajouté dans `notifuse-veridian/CLAUDE.md` une section
"Secrets HMAC cross-app — matrice exhaustive" couvrant la VUE
**Notifuse-side** :
- Inbound depuis Hub (`/api/tenants/*`, `/api/veridian/admin/*`, etc.)
- Outbound vers Hub (discovery `/api/users/by-email`, invitation
  `/api/invitations/create`, webhooks)

La VUE **Hub-side** manque. Quand un agent Hub debug un 401 HMAC sur un
endpoint inbound (app → Hub), il doit aujourd'hui chercher dans le code
quel secret env couvre quel endpoint. Même pénibilité qu'avant le ticket
Notifuse.

## Demande

### 1. Ajouter une section dans `veridian-hub/CLAUDE.md`

Format aligné sur la section Notifuse (table par sens du flux + headers
communs + où trouver les valeurs + conventions code + pièges). Couvrir
au minimum :

| Endpoint Hub | Secret Hub-env | App caller | Secret app-env (= même valeur) |
|---|---|---|---|
| `GET /api/users/by-email` | `NOTIFUSE_HUB_API_SECRET` (+ `PROSPECTION_*`, `ANALYTICS_*`, `CMS_*` selon `x-veridian-app`) | notifuse, prospection, analytics, cms | `HUB_API_SECRET` côté app |
| `POST /api/invitations/create` | `HUB_INVITATION_SECRET_NOTIFUSE` (+ équivalents prospection/analytics/cms) | apps cross-invitation | `HUB_INVITATION_SECRET_<APP>` |
| `POST /api/webhooks/<app>` (inbound webhooks app → Hub) | `<APP>_HUB_WEBHOOK_SECRET` | notifuse (`X-Veridian-Notifuse-Signature`), idem autres apps | `HUB_WEBHOOK_SECRET` côté app |

Plus la vue OUTBOUND Hub → app :

| Endpoint app cible | Secret Hub-env utilisé | App cible | Secret app-env (= même valeur) |
|---|---|---|---|
| `POST /api/tenants/provision`, `/api/tenants/*`, `/api/veridian/admin/*`, `/api/sso/issue-magic-link`, `POST /api/users/by-email` (Notifuse) | `NOTIFUSE_HUB_API_SECRET` | notifuse | `HUB_API_SECRET` |
| Équivalents prospection / analytics / cms | `PROSPECTION_HUB_API_SECRET` etc. | apps | idem |

### 2. Pointeur léger dans le CLAUDE.md racine

Le racine `veridian-platform/CLAUDE.md` est un **symlink** vers
`veridian-hub/docs/CLAUDE-ROOT.md` (donc géré côté Hub). L'agent
Notifuse n'a pas pu l'éditer (refus d'écrire à travers symlink hors
worktree).

Ajouter un paragraphe court dans `CLAUDE-ROOT.md` (après "## Règle
opérationnelle : APIs pilotées par le Hub", avant "## Vision cible") :

```markdown
### Secrets HMAC cross-app — où trouver la matrice

Toutes les routes cross-app sont signées HMAC-SHA256. Le mapping
exhaustif (secret Notifuse-side vs Hub-side, header, canonical-string
POST vs GET, endpoints, pièges historiques) est maintenu **par app**
dans le `CLAUDE.md` de l'app concernée :

- Vue Notifuse-side : `notifuse-veridian/CLAUDE.md` section
  "Secrets HMAC cross-app — matrice exhaustive"
- Vue Hub-side : `veridian-hub/CLAUDE.md` section équivalente

Règle : tout nouveau endpoint HMAC cross-app DOIT étendre la matrice
de l'app concernée dans le même commit qui introduit l'endpoint.
```

## Pourquoi

- Symétrie de doc avec Notifuse : un agent qui passe d'un repo à l'autre
  trouve la même structure
- Onboarding nouvel agent Hub : 2 min de table de référence au lieu de
  30 min de fouille `app/api/**/route.ts`
- Sécurité : visibilité immédiate sur quel secret est partagé avec quelle
  app — utile lors d'une rotation ou d'un audit

## Définition de done

- [ ] Section "Secrets HMAC cross-app" dans `veridian-hub/CLAUDE.md`
- [ ] Paragraphe pointeur dans `veridian-hub/docs/CLAUDE-ROOT.md`
- [ ] Convention "tout nouveau endpoint HMAC = MAJ matrice" mentionnée
- [ ] Pas besoin de cross-app sync (pure doc, lecture seule côté Notifuse)

## Référence

- Matrice Notifuse livrée : `notifuse-veridian/CLAUDE.md` section
  "Secrets HMAC cross-app — matrice exhaustive" (commit `<sha>` agent
  Notifuse 2026-05-25)
- Ticket source : `notifuse-veridian/todo/done/2026-05-24-secrets-hmac-cross-app-doc-CLAUDE.md`
