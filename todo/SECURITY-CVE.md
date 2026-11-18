# 🔒 Veille CVE automatique — veridian-hub

> **Généré par** : `veridian-infra/.github/workflows/cron-trivy.yml`
> **Dernier run** : 2026-08-18 04:07 UTC
> **Run URL** : local-cron@mail.mybigserveur.local:2026-08-18
> **Image scannée** : `ghcr.io/christ-roy/veridian-hub:latest`
> **CVE bruts détectés** : 5 (avant filtrage)
> **Scoring** : `veridian-infra/ci/trivy-scoring.yml`

## TL;DR

- 🚨 **0 RED** — fix prioritaire
- 🔴 **0 HIGH** — action recommandée cette semaine
- 🟡 **5 MEDIUM** — récap, pas urgent
- 🟢 **0 NOISE** — annexe collapse

✅ **Rien d'urgent.** Quelques items MEDIUM à voir quand t'as 5 min.


---

## 🟡 MEDIUM — 5 CVE en 4 groupes

### 1. `@hono/node-server` — 1.19.11 → **2.0.5**

- **CVE** : `CVE-2026-39406` (MEDIUM/Auth bypass), `GHSA-frvp-7c67-39w9` (MEDIUM/Data leak)
- **Type** : Auth bypass, Data leak
- **Score max** : 18
- **Title** : @hono/node-server: Middleware bypass via repeated slashes in serveStatic
- **Source** : `Node.js`
- **Fix** : `pnpm up @hono/node-server` (jusqu'à >= `2.0.5`)

### 2. `deepmerge-ts` — 7.1.5 → **8.0.0**

- **CVE** : `CVE-2026-40345` (HIGH/Unclassified)
- **Type** : Unclassified
- **Score max** : 15
- **Title** : DeepmergeTS has stack exhaustion when merging recursive object graphs
- **Source** : `Node.js`
- **Fix** : `pnpm up deepmerge-ts` (jusqu'à >= `8.0.0`)

### 3. `nanoid` — 3.3.16 → **5.1.6**

- **CVE** : `CVE-2026-67213` (HIGH/DoS)
- **Type** : DoS
- **Score max** : 15
- **Title** : nanoid: nanoid: Denial of Service via infinite loop in random ID generation
- **Source** : `Node.js`
- **Fix** : `pnpm up nanoid` (jusqu'à >= `5.1.6`)

### 4. `valibot` — 1.2.0 → **1.4.2**

- **CVE** : `CVE-2026-59952` (MEDIUM/Data leak)
- **Type** : Data leak
- **Score max** : 12
- **Title** : Valibot: record() issue paths can make flatten() throw for inherited Object property names
- **Source** : `Node.js`
- **Fix** : `pnpm up valibot` (jusqu'à >= `1.4.2`)


---

## Comment réagir

1. **Tu fixes** → bump la dep / la base image, push sur `staging`. Le prochain tick (24h) confirme.
2. **Tu acks le risque** → ajoute un override dans [`veridian-infra/ci/trivy-overrides.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-overrides.yml) avec date d'expiration + raison.
3. **Tu ignores** → ne fais rien, le tick recréera ce fichier demain à l'identique.

> Tu peux **supprimer ce fichier librement**. Il sera recréé au prochain tick s'il reste des items à signaler. C'est l'idempotence qui garantit qu'on ne perd rien.

*Pour ajuster les règles : [`veridian-infra/ci/trivy-scoring.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-scoring.yml). Ping infra-agent.*
