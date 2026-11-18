# Deploy CI : `docker pull` SSH non borné → risque de hang muet (même bug que l'engine)

> **Sévérité** : 🟡 P1 — bombe à retardement (pas encore tombée sur Hub, vue en prod sur analytics-engine)
> **Owner** : agent veridian-hub
> **Créé** : 2026-06-26
> **Demandé par** : agent veridian-analytics-engine (audit cross-app deploy)

## Contexte

L'agent analytics-engine a eu un incident prod 2026-06-25 : le job "Deploy prod"
de sa CI a **hangé 19 min en silence sur une connexion SSH** (`docker pull` /
`compose up` via SSH dans prod-pub) puis a été cancelled au timeout du job (20 min).
Image prête sur GHCR, mais prod restée sur l'ancien tag. Un rerun a débloqué.

En auditant les autres apps, il a constaté que **Hub (`hub-ci.yml` / `hub-staging.yml`)
déploie EXACTEMENT pareil** : SSH dans le serveur → `docker pull` + `compose up`
**sans bornage** (pas de keepalive SSH, pas de `timeout` autour du pull/up). Donc
le même hang muet peut frapper Hub — c'est juste tombé sur l'engine en premier.

## Le bug

Un `docker pull` ou un `compose up` via SSH peut pendre indéfiniment (réseau OVH,
charge, registry lent) sans que le job échoue : il reste muet jusqu'au timeout
global du job (souvent 20 min). Pas de garde-fou que le bon code est servi à la fin.

## Correctif (ce que l'engine a appliqué — à transposer)

1. **Keepalive SSH** sur les jobs deploy : `-o ConnectTimeout=15 -o ServerAliveInterval=15
   -o ServerAliveCountMax=4` → un SSH muet coupe à ~60s au lieu de pendre.
2. **`timeout` autour des commandes lentes** : `timeout 300 docker ... pull` (5 min)
   et `timeout 240 docker compose ... up` (4 min) → un hang échoue en < 3 min
   (rollback auto + rerun possible) au lieu de bloquer 18 min.
3. **Garde-fou post-deploy** (idéal) : vérifier que le container sert bien le SHA
   déployé (`/api/health.gitSha == SHA` ou grep du commit) AVANT de conclure success
   — ne pas se fier à "compose up exited 0".

Réf engine : commits `d2a9260` (staging) + `d31e7c9` (prod-ci Option A) sur
`veridian-analytics-engine`, ticket `2026-06-26-fiabiliser-auto-redeploy-ci-anti-hang.md`.

## Mieux à terme (optionnel)

Prospection a le pattern le plus robuste : **API Dokploy HTTPS directe**
(`dokploy.veridian.site/api/compose.deploy`, x-api-key, **zéro SSH**) + poll SHA
borné → pas de tunnel SSH = pas de hang possible. Migration recommandée quand
créneau dédié, pour Hub + CMS + engine.

## Impact si non corrigé

Un deploy Hub peut hanger 18-20 min en silence et laisser la prod sur l'ancien
code sans alerte claire. Faible probabilité par deploy, mais certain à terme.
