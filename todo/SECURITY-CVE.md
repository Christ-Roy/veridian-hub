# 🔒 Veille CVE automatique — veridian-hub

> **Généré par** : `veridian-infra/.github/workflows/cron-trivy.yml`
> **Dernier run** : 2026-07-31 04:06 UTC
> **Run URL** : local-cron@mail.mybigserveur.local:2026-07-31
> **Image scannée** : `ghcr.io/christ-roy/veridian-hub:latest`
> **CVE bruts détectés** : 30 (avant filtrage)
> **Scoring** : `veridian-infra/ci/trivy-scoring.yml`

## TL;DR

- 🚨 **0 RED** — fix prioritaire
- 🔴 **6 HIGH** — action recommandée cette semaine
- 🟡 **16 MEDIUM** — récap, pas urgent
- 🟢 **8 NOISE** — annexe collapse


---

## 🔴 HIGH — 6 CVE en 4 groupes

### 1. `fast-uri` — 3.1.3 → **4.1.1**

- **CVE** : `CVE-2026-16221` (HIGH/SSRF)
- **Type** : SSRF
- **Score max** : 45
- **Title** : Impact: fast-uri versions from 2.3.1 through 4.1.0 (including the 3.x  ...
- **Source** : `Node.js`
- **Fix** : `pnpm up fast-uri` (jusqu'à >= `4.1.1`)

### 2. `next` — 15.5.18 → **16.2.11**

- **CVE** : `CVE-2026-64645` (HIGH/SSRF), `CVE-2026-64649` (HIGH/SSRF)
- **Type** : SSRF
- **Score max** : 45
- **Title** : next: Next.js: Server-Side Request Forgery vulnerability
- **Source** : `Node.js`
- **Fix** : `pnpm up next` (jusqu'à >= `16.2.11`)

### 3. `postcss` — 8.4.31 → **8.5.18**

- **CVE** : `CVE-2026-45623` (HIGH/Data leak), `GHSA-r28c-9q8g-f849` (HIGH/Data leak)
- **Type** : Data leak
- **Score max** : 30
- **Title** : postcss: PostCSS: Information disclosure and denial of service via crafted CSS input
- **Source** : `Node.js`
- **Fix** : `pnpm up postcss` (jusqu'à >= `8.5.18`)

### 4. `tar` — 7.5.11 → **7.5.19**

- **CVE** : `CVE-2026-59873` (CRITICAL/DoS)
- **Type** : DoS
- **Score max** : 30
- **Title** : tar: node-tar: Denial of Service via crafted gzip bomb
- **Source** : `Node.js`
- **Fix** : `pnpm up tar` (jusqu'à >= `7.5.19`)


---

## 🟡 MEDIUM — 16 CVE en 10 groupes

### 1. `@hono/node-server` — 1.19.11 → **2.0.5**

- **CVE** : `CVE-2026-39406` (MEDIUM/Auth bypass), `GHSA-frvp-7c67-39w9` (MEDIUM/Data leak)
- **Type** : Auth bypass, Data leak
- **Score max** : 18
- **Title** : @hono/node-server: Middleware bypass via repeated slashes in serveStatic
- **Source** : `Node.js`
- **Fix** : `pnpm up @hono/node-server` (jusqu'à >= `2.0.5`)

### 2. `picomatch` — 4.0.3 → **4.0.4**

- **CVE** : `CVE-2026-33672` (MEDIUM/Auth bypass), `CVE-2026-33671` (HIGH/DoS)
- **Type** : Auth bypass, DoS
- **Score max** : 18
- **Title** : picomatch: Picomatch: Data integrity compromised via method injection with crafted POSIX bracket expressions
- **Source** : `Node.js`
- **Fix** : `pnpm up picomatch` (jusqu'à >= `4.0.4`)

### 3. `brace-expansion` — 2.0.2 → **5.0.8**

- **CVE** : `CVE-2026-13149` (HIGH/DoS), `CVE-2026-14257` (HIGH/DoS)
- **Type** : DoS
- **Score max** : 15
- **Title** : brace-expansion: Brace-expansion: Denial of Service due to exponential-time complexity
- **Source** : `Node.js`
- **Fix** : `pnpm up brace-expansion` (jusqu'à >= `5.0.8`)

### 4. `next` — 15.5.18 → **16.2.11**

- **CVE** : `CVE-2026-64641` (HIGH/DoS), `CVE-2026-64643` (MEDIUM/Data leak), `CVE-2026-64647` (MEDIUM/Data leak), `CVE-2026-64648` (MEDIUM/Data leak)
- **Type** : Data leak, DoS
- **Score max** : 15
- **Title** : next: Next.js: Denial of Service via crafted requests to App Router with Server Actions
- **Source** : `Node.js`
- **Fix** : `pnpm up next` (jusqu'à >= `16.2.11`)

### 5. `sharp` — 0.34.5 → **0.35.0**

- **CVE** : `GHSA-f88m-g3jw-g9cj` (HIGH/Unclassified)
- **Type** : Unclassified
- **Score max** : 15
- **Title** : sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591
- **Source** : `Node.js`
- **Fix** : `pnpm up sharp` (jusqu'à >= `0.35.0`)

### 6. `sigstore` — 3.1.0 → **4.1.1**

- **CVE** : `CVE-2026-48815` (HIGH/Unclassified)
- **Type** : Unclassified
- **Score max** : 15
- **Title** : sigstore: Sigstore: Unauthorized certificates accepted due to ignored `certificateOIDs` verification option
- **Source** : `Node.js`
- **Fix** : `pnpm up sigstore` (jusqu'à >= `4.1.1`)

### 7. `tar` — 7.5.11 → **7.5.18**

- **CVE** : `CVE-2026-59874` (HIGH/DoS)
- **Type** : DoS
- **Score max** : 15
- **Title** : tar: Node-tar: Denial of Service via malformed tar archive header
- **Source** : `Node.js`
- **Fix** : `pnpm up tar` (jusqu'à >= `7.5.18`)

### 8. `ip-address` — 10.1.0 → **10.1.1**

- **CVE** : `CVE-2026-42338` (MEDIUM/XSS)
- **Type** : XSS
- **Score max** : 12
- **Title** : ip-address: ip-address: Cross-site scripting via improper HTML escaping of untrusted input
- **Source** : `Node.js`
- **Fix** : `pnpm up ip-address` (jusqu'à >= `10.1.1`)

### 9. `postcss` — 8.4.31 → **8.5.10**

- **CVE** : `CVE-2026-41305` (MEDIUM/XSS)
- **Type** : XSS
- **Score max** : 12
- **Title** : postcss: PostCSS: Cross-Site Scripting (XSS) via improper escaping of style closing tags
- **Source** : `Node.js`
- **Fix** : `pnpm up postcss` (jusqu'à >= `8.5.10`)

### 10. `valibot` — 1.2.0 → **1.4.2**

- **CVE** : `CVE-2026-59952` (MEDIUM/Data leak)
- **Type** : Data leak
- **Score max** : 12
- **Title** : Valibot: record() issue paths can make flatten() throw for inherited Object property names
- **Source** : `Node.js`
- **Fix** : `pnpm up valibot` (jusqu'à >= `1.4.2`)


---

## 🟢 NOISE filtré (8 CVE)

<details>
<summary>Liste complète (4 groupes — clique pour déplier)</summary>

| Package | Installed | Fix | CVE count | Max score |
|---|---|---|---|---|
| `@sigstore/core` | 2.0.0 | 3.2.1 | 1 | 6 |
| `brace-expansion` | 2.0.2 | 5.0.5 | 1 | 6 |
| `next` | 15.5.18 | 16.2.11 | 2 | 6 |
| `tar` | 7.5.11 | 7.5.21 | 4 | 6 |

</details>


---

## Comment réagir

1. **Tu fixes** → bump la dep / la base image, push sur `staging`. Le prochain tick (24h) confirme.
2. **Tu acks le risque** → ajoute un override dans [`veridian-infra/ci/trivy-overrides.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-overrides.yml) avec date d'expiration + raison.
3. **Tu ignores** → ne fais rien, le tick recréera ce fichier demain à l'identique.

> Tu peux **supprimer ce fichier librement**. Il sera recréé au prochain tick s'il reste des items à signaler. C'est l'idempotence qui garantit qu'on ne perd rien.

*Pour ajuster les règles : [`veridian-infra/ci/trivy-scoring.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-scoring.yml). Ping infra-agent.*
