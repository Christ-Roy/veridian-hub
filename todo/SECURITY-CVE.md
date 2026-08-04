# 🔒 Veille CVE automatique — veridian-hub

> **Généré par** : `veridian-infra/.github/workflows/cron-trivy.yml`
> **Dernier run** : 2026-08-04 04:08 UTC
> **Run URL** : local-cron@mail.mybigserveur.local:2026-08-04
> **Image scannée** : `ghcr.io/christ-roy/veridian-hub:latest`
> **CVE bruts détectés** : 6 (avant filtrage)
> **Scoring** : `veridian-infra/ci/trivy-scoring.yml`

## TL;DR

- 🚨 **0 RED** — fix prioritaire
- 🔴 **1 HIGH** — action recommandée cette semaine
- 🟡 **3 MEDIUM** — récap, pas urgent
- 🟢 **1 NOISE** — annexe collapse


---

## 🔴 HIGH — 1 CVE en 1 groupe

### 1. `fast-uri` — 4.1.1 → **4.1.2**

- **CVE** : `CVE-2026-18446` (HIGH/SSRF)
- **Type** : SSRF
- **Score max** : 45
- **Title** : fast-uri before 4.1.2, 3.1.5, and 2.4.4 requires a literal double forw ...
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up fast-uri` (jusqu'à >= `4.1.2`)


---

## 🟡 MEDIUM — 3 CVE en 2 groupes

### 1. `@hono/node-server` — 1.19.11 → **2.0.5**

- **CVE** : `CVE-2026-39406` (MEDIUM/Auth bypass), `GHSA-frvp-7c67-39w9` (MEDIUM/Data leak)
- **Type** : Auth bypass, Data leak
- **Score max** : 18
- **Title** : @hono/node-server: Middleware bypass via repeated slashes in serveStatic
- **Source** : `Node.js`
- **Fix** : `pnpm up @hono/node-server` (jusqu'à >= `2.0.5`)

### 2. `valibot` — 1.2.0 → **1.4.2**

- **CVE** : `CVE-2026-59952` (MEDIUM/Data leak)
- **Type** : Data leak
- **Score max** : 12
- **Title** : Valibot: record() issue paths can make flatten() throw for inherited Object property names
- **Source** : `Node.js`
- **Fix** : `pnpm up valibot` (jusqu'à >= `1.4.2`)


---

## 🟢 NOISE filtré (1 CVE)

<details>
<summary>Liste complète (1 groupe — clique pour déplier)</summary>

| Package | Installed | Fix | CVE count | Max score |
|---|---|---|---|---|
| `hono` | 4.12.32 | 4.12.34 | 1 | 6 |

</details>


---

## Comment réagir

1. **Tu fixes** → bump la dep / la base image, push sur `staging`. Le prochain tick (24h) confirme.
2. **Tu acks le risque** → ajoute un override dans [`veridian-infra/ci/trivy-overrides.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-overrides.yml) avec date d'expiration + raison.
3. **Tu ignores** → ne fais rien, le tick recréera ce fichier demain à l'identique.

> Tu peux **supprimer ce fichier librement**. Il sera recréé au prochain tick s'il reste des items à signaler. C'est l'idempotence qui garantit qu'on ne perd rien.

*Pour ajuster les règles : [`veridian-infra/ci/trivy-scoring.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-scoring.yml). Ping infra-agent.*
