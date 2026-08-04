# Ateliers UI (`/dev/*`)

Bancs d'essai visuels pour travailler une interface **sans dépendre du
backend** : pas de session Auth.js, pas de Prisma, pas d'appel réseau. On
ouvre une URL, on modifie le code, la page se met à jour toute seule.

## Marche à suivre

```bash
cd ~/Bureau/veridian-platform/veridian-hub
bash scripts/dev/atelier-ui.sh          # ou : pnpm dev:atelier
```

Puis ouvrir **http://100.108.136.89:3010/dev/onboarding** (IP Tailscale du
bastion). Toute modification d'un fichier sous `components/onboarding/` ou
`app/dev/` se recharge à chaud dans le navigateur, sans rafraîchir.

Port occupé ? `PORT=3011 pnpm dev:atelier`.

## Ce qui est exposé, et à qui

Le dev server se lie à l'**interface Tailscale uniquement** (`tailscale0`),
jamais à `0.0.0.0` : rien n'est joignable depuis l'IP publique Contabo. Le
script refuse de démarrer si Tailscale n'est pas up. Contrôle :

```bash
ss -tlnp | grep 3010     # doit afficher 100.108.136.89:3010, jamais 0.0.0.0
```

## Ateliers disponibles

### `/dev/onboarding` — première connexion client

Rend les six états du flow décrit dans
`todo/2026-07-06-onboarding-premiere-connexion-client.md`, sélectionnables
depuis la barre en haut de page (ou via `?etat=<id>`) :

| État | `?etat=` |
|---|---|
| Compte à activer | `activation` |
| Mot de passe à définir | `mot-de-passe` |
| Onboarding en cours | `en-cours` |
| Onboarding terminé | `termine` |
| Erreur technique | `erreur` |
| Lien expiré | `token-expire` |

La barre permet aussi de basculer clair/sombre, de simuler une largeur
mobile (375 px) et de rejouer l'écran (animations, confettis). Pour l'état
« en cours », trois variantes de provisioning sont proposées : à mi-parcours,
tout au vert, échec.

Les données affichées sont fictives (`components/onboarding/mocks.ts`) et ne
correspondent à aucun client réel.

## Pourquoi ça ne peut pas fuiter en production

Deux verrous indépendants :

1. **Build** — les fichiers de route s'appellent `page.dev.tsx` /
   `layout.dev.tsx`. `next.config.js` n'ajoute l'extension `dev.tsx` à
   `pageExtensions` que hors production : dans un build prod, ces fichiers ne
   sont pas des pages, la route n'existe pas dans le bundle. Vérifié :
   `.next/server/app` ne contient aucun dossier `dev` après `pnpm build`.
2. **Runtime** — `lib/dev/harness-guard.ts`, appelé par le layout d'atelier,
   renvoie un 404 dès qu'un signal indique la production (`NODE_ENV`,
   `DEPLOY_ENV`, domaine `app.veridian.site`).

## Ajouter un atelier

1. Créer `app/dev/<sujet>/page.dev.tsx` et `layout.dev.tsx` (copier ceux de
   `app/dev/onboarding/`, le layout doit appeler `isDevHarnessEnabled()`).
2. Mettre les écrans dans `components/<sujet>/`, purement présentationnels :
   des props en entrée, aucun accès session ni DB. C'est cette contrainte qui
   rend l'atelier possible et qui laisse la future page réelle réutiliser les
   mêmes composants tels quels.
3. Mettre les données fictives dans un `mocks.ts` à part, jamais importé par
   du code de production.
