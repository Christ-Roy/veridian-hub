# 🔒 Veille CVE automatique — veridian-hub

> **Généré par** : `veridian-infra/.github/workflows/cron-trivy.yml`
> **Dernier run** : 2026-06-13 04:05 UTC
> **Run URL** : local-cron@mail.mybigserveur.local:2026-06-13
> **Image scannée** : `ghcr.io/christ-roy/veridian-hub:latest`
> **CVE bruts détectés** : 23 (avant filtrage)
> **Scoring** : `veridian-infra/ci/trivy-scoring.yml`

## TL;DR

- 🚨 **0 RED** — fix prioritaire
- 🔴 **1 HIGH** — action recommandée cette semaine
- 🟡 **6 MEDIUM** — récap, pas urgent
- 🟢 **10 NOISE** — annexe collapse


---

## 🔴 HIGH — 1 CVE en 1 groupe

### 1. `esbuild` — 0.27.7 → **0.28.1**

- **CVE** : `GHSA-gv7w-rqvm-qjhr` (HIGH/RCE)
- **Type** : RCE
- **Score max** : 75
- **Title** : esbuild: Missing binary integrity verification in Deno module enables remote code execution via NPM_CONFIG_REGISTRY
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up esbuild` (jusqu'à >= `0.28.1`)


---

## 🟡 MEDIUM — 6 CVE en 5 groupes

### 1. `@hono/node-server` — 1.19.11 → **1.19.13**

- **CVE** : `CVE-2026-39406` (MEDIUM/Auth bypass)
- **Type** : Auth bypass
- **Score max** : 18
- **Title** : @hono/node-server: Middleware bypass via repeated slashes in serveStatic
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up @hono/node-server` (jusqu'à >= `1.19.13`)

### 2. `picomatch` — 4.0.3 → **4.0.4**

- **CVE** : `CVE-2026-33672` (MEDIUM/Auth bypass), `CVE-2026-33671` (HIGH/DoS)
- **Type** : Auth bypass, DoS
- **Score max** : 18
- **Title** : picomatch: Picomatch: Data integrity compromised via method injection with crafted POSIX bracket expressions
- **Source** : `Node.js`
- **Fix** : `pnpm up picomatch` (jusqu'à >= `4.0.4`)

### 3. `libssl3` + `libcrypto3` — 3.5.6-r0 → **3.5.7-r0** *(base image OS)*

- **CVE** : `CVE-2026-45447` (HIGH/Memory corruption)
- **Type** : Memory corruption
- **Score max** : 15.0
- **Title** : openssl: Heap Use-After-Free in OpenSSL PKCS7_verify()
- **Source** : `ghcr.io/christ-roy/veridian-hub:latest (alpine 3.24.0)`
- **Fix** : rebuild image avec base image patchée — `libssl3` >= `3.5.7-r0`

### 4. `postcss` — 8.4.31 → **8.5.10**

- **CVE** : `CVE-2026-41305` (MEDIUM/XSS)
- **Type** : XSS
- **Score max** : 12
- **Title** : postcss: PostCSS: Cross-Site Scripting (XSS) via improper escaping of style closing tags
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up postcss` (jusqu'à >= `8.5.10`)

### 5. `ip-address` — 10.1.0 → **10.1.1**

- **CVE** : `CVE-2026-42338` (MEDIUM/XSS)
- **Type** : XSS
- **Score max** : 12
- **Title** : ip-address: ip-address: Cross-site scripting via improper HTML escaping of untrusted input
- **Source** : `Node.js`
- **Fix** : `pnpm up ip-address` (jusqu'à >= `10.1.1`)


---

## 🟢 NOISE filtré (10 CVE)

<details>
<summary>Liste complète (4 groupes — clique pour déplier)</summary>

| Package | Installed | Fix | CVE count | Max score |
|---|---|---|---|---|
| `hono` | 4.12.18 | 4.12.21 | 4 | 6 |
| `qs` | 6.15.1 | 6.15.2 | 1 | 6 |
| `brace-expansion` | 2.0.2 | 5.0.5 | 1 | 6 |
| `libssl3` | 3.5.6-r0 | 3.5.7-r0 | 4 | 3.0 |

</details>


---

## Comment réagir

1. **Tu fixes** → bump la dep / la base image, push sur `staging`. Le prochain tick (24h) confirme.
2. **Tu acks le risque** → ajoute un override dans [`veridian-infra/ci/trivy-overrides.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-overrides.yml) avec date d'expiration + raison.
3. **Tu ignores** → ne fais rien, le tick recréera ce fichier demain à l'identique.

> Tu peux **supprimer ce fichier librement**. Il sera recréé au prochain tick s'il reste des items à signaler. C'est l'idempotence qui garantit qu'on ne perd rien.

*Pour ajuster les règles : [`veridian-infra/ci/trivy-scoring.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-scoring.yml). Ping infra-agent.*
