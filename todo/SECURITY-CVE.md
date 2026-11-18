# 🔒 Veille CVE automatique — veridian-hub

> **Généré par** : `veridian-infra/.github/workflows/cron-trivy.yml`
> **Dernier run** : 2026-07-29 04:06 UTC
> **Run URL** : local-cron@mail.mybigserveur.local:2026-07-29
> **Image scannée** : `ghcr.io/christ-roy/veridian-hub:latest`
> **CVE bruts détectés** : 62 (avant filtrage)
> **Scoring** : `veridian-infra/ci/trivy-scoring.yml`

## TL;DR

- 🚨 **1 RED** — fix prioritaire
- 🔴 **7 HIGH** — action recommandée cette semaine
- 🟡 **21 MEDIUM** — récap, pas urgent
- 🟢 **13 NOISE** — annexe collapse


---

## 🚨 RED — 1 CVE en 1 groupe

### 1. `next-auth` — 5.0.0-beta.30 → **5.0.0-beta.32**

- **CVE** : `GHSA-8fpg-xm3f-6cx3` (CRITICAL/Auth bypass)
- **Type** : Auth bypass
- **Score max** : 90
- **Title** : Auth.js: Configuration errors can cause existence-based auth checks to fail open (auth object populated with an error)
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up next-auth` (jusqu'à >= `5.0.0-beta.32`)


---

## 🔴 HIGH — 7 CVE en 6 groupes

### 1. `fast-uri` — 3.1.2 → **4.1.1**

- **CVE** : `CVE-2026-16221` (HIGH/SSRF)
- **Type** : SSRF
- **Score max** : 45
- **Title** : Impact: fast-uri versions from 2.3.1 through 4.1.0 (including the 3.x  ...
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up fast-uri` (jusqu'à >= `4.1.1`)

### 2. `next` — 15.5.18 → **16.2.11**

- **CVE** : `CVE-2026-64645` (HIGH/SSRF), `CVE-2026-64649` (HIGH/SSRF)
- **Type** : SSRF
- **Score max** : 45
- **Title** : Next.js: Server-Side Request Forgery in rewrites via attacker-controlled destination hostname
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up next` (jusqu'à >= `16.2.11`)

### 3. `@auth/core` — 0.41.0 → **0.41.3**

- **CVE** : `GHSA-7rqj-j65f-68wh` (CRITICAL/Unclassified)
- **Type** : Unclassified
- **Score max** : 30
- **Aussi affectés** (même CVE) : `next-auth`
- **Title** : Auth.js: Email normalizer validates the address before Unicode normalization, allowing a homoglyph @ bypass
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up @auth/core` (jusqu'à >= `0.41.3`)

### 4. `next-auth` — 5.0.0-beta.30 → **5.0.0-beta.32**

- **CVE** : `GHSA-7rqj-j65f-68wh` (CRITICAL/Unclassified)
- **Type** : Unclassified
- **Score max** : 30
- **Aussi affectés** (même CVE) : `@auth/core`
- **Title** : Auth.js: Email normalizer validates the address before Unicode normalization, allowing a homoglyph @ bypass
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up next-auth` (jusqu'à >= `5.0.0-beta.32`)

### 5. `postcss` — 8.4.31 → **8.5.18**

- **CVE** : `GHSA-r28c-9q8g-f849` (HIGH/Data leak)
- **Type** : Data leak
- **Score max** : 30
- **Title** : PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up postcss` (jusqu'à >= `8.5.18`)

### 6. `tar` — 7.5.11 → **7.5.19**

- **CVE** : `CVE-2026-59873` (CRITICAL/DoS)
- **Type** : DoS
- **Score max** : 30
- **Title** : tar: node-tar: Denial of Service via crafted gzip bomb
- **Source** : `Node.js`
- **Fix** : `pnpm up tar` (jusqu'à >= `7.5.19`)


---

## 🟡 MEDIUM — 21 CVE en 14 groupes

### 1. `@hono/node-server` — 1.19.11 → **2.0.5**

- **CVE** : `CVE-2026-39406` (MEDIUM/Auth bypass), `GHSA-frvp-7c67-39w9` (MEDIUM/Data leak)
- **Type** : Auth bypass, Data leak
- **Score max** : 18
- **Title** : @hono/node-server: Middleware bypass via repeated slashes in serveStatic
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up @hono/node-server` (jusqu'à >= `2.0.5`)

### 2. `picomatch` — 4.0.3 → **4.0.4**

- **CVE** : `CVE-2026-33672` (MEDIUM/Auth bypass), `CVE-2026-33671` (HIGH/DoS)
- **Type** : Auth bypass, DoS
- **Score max** : 18
- **Title** : picomatch: Picomatch: Data integrity compromised via method injection with crafted POSIX bracket expressions
- **Source** : `Node.js`
- **Fix** : `pnpm up picomatch` (jusqu'à >= `4.0.4`)

### 3. `@auth/core` — 0.41.0 → **0.41.3**

- **CVE** : `GHSA-xmf8-cvqr-rfgj` (HIGH/DoS), `GHSA-x445-f3h2-j279` (MEDIUM/CSRF)
- **Type** : CSRF, DoS
- **Score max** : 15
- **Aussi affectés** (même CVE) : `next-auth`
- **Title** : Auth.js: getToken() throws an uncaught exception on malformed Bearer authorization headers
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up @auth/core` (jusqu'à >= `0.41.3`)

### 4. `fast-uri` — 3.1.2 → **4.0.1**

- **CVE** : `CVE-2026-13676` (HIGH/Unclassified)
- **Type** : Unclassified
- **Score max** : 15
- **Title** : fast-uri: fast-uri: Security policy bypass due to improper Unicode hostname canonicalization
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up fast-uri` (jusqu'à >= `4.0.1`)

### 5. `next` — 15.5.18 → **16.2.11**

- **CVE** : `CVE-2026-64641` (HIGH/DoS)
- **Type** : DoS
- **Score max** : 15
- **Title** : Next.js: Denial of Service in App Router using Server Actions
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up next` (jusqu'à >= `16.2.11`)

### 6. `next-auth` — 5.0.0-beta.30 → **5.0.0-beta.32**

- **CVE** : `GHSA-xmf8-cvqr-rfgj` (HIGH/DoS), `GHSA-x445-f3h2-j279` (MEDIUM/CSRF)
- **Type** : CSRF, DoS
- **Score max** : 15
- **Aussi affectés** (même CVE) : `@auth/core`
- **Title** : Auth.js: getToken() throws an uncaught exception on malformed Bearer authorization headers
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up next-auth` (jusqu'à >= `5.0.0-beta.32`)

### 7. `postcss` — 8.4.31 → **8.5.12**

- **CVE** : `CVE-2026-45623` (HIGH/Unclassified), `CVE-2026-41305` (MEDIUM/XSS)
- **Type** : Unclassified, XSS
- **Score max** : 15
- **Title** : PostCSS takes a CSS file and provides an API to analyze and modify its ...
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up postcss` (jusqu'à >= `8.5.12`)

### 8. `sharp` — 0.34.5 → **0.35.0**

- **CVE** : `GHSA-f88m-g3jw-g9cj` (HIGH/Unclassified)
- **Type** : Unclassified
- **Score max** : 15
- **Title** : sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up sharp` (jusqu'à >= `0.35.0`)

### 9. `brace-expansion` — 2.0.2 → **5.0.8**

- **CVE** : `CVE-2026-13149` (HIGH/DoS), `CVE-2026-14257` (HIGH/DoS)
- **Type** : DoS
- **Score max** : 15
- **Title** : brace-expansion: Brace-expansion: Denial of Service due to exponential-time complexity
- **Source** : `Node.js`
- **Fix** : `pnpm up brace-expansion` (jusqu'à >= `5.0.8`)

### 10. `sigstore` — 3.1.0 → **4.1.1**

- **CVE** : `CVE-2026-48815` (HIGH/Unclassified)
- **Type** : Unclassified
- **Score max** : 15
- **Title** : sigstore: Sigstore: Unauthorized certificates accepted due to ignored `certificateOIDs` verification option
- **Source** : `Node.js`
- **Fix** : `pnpm up sigstore` (jusqu'à >= `4.1.1`)

### 11. `tar` — 7.5.11 → **7.5.18**

- **CVE** : `CVE-2026-59874` (HIGH/DoS)
- **Type** : DoS
- **Score max** : 15
- **Title** : tar: Node-tar: Denial of Service via malformed tar archive header
- **Source** : `Node.js`
- **Fix** : `pnpm up tar` (jusqu'à >= `7.5.18`)

### 12. `hono` — 4.12.25 → **4.12.27**

- **CVE** : `CVE-2026-59896` (MEDIUM/Data leak), `CVE-2026-59897` (MEDIUM/Data leak)
- **Type** : Data leak
- **Score max** : 12
- **Title** : hono: Hono: Information disclosure due to improper context isolation in server-side rendering
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up hono` (jusqu'à >= `4.12.27`)

### 13. `valibot` — 1.2.0 → **1.4.2**

- **CVE** : `CVE-2026-59952` (MEDIUM/Data leak)
- **Type** : Data leak
- **Score max** : 12
- **Title** : Valibot: record() issue paths can make flatten() throw for inherited Object property names
- **Source** : `pnpm-lock.yaml`
- **Fix** : `pnpm up valibot` (jusqu'à >= `1.4.2`)

### 14. `ip-address` — 10.1.0 → **10.1.1**

- **CVE** : `CVE-2026-42338` (MEDIUM/XSS)
- **Type** : XSS
- **Score max** : 12
- **Title** : ip-address: ip-address: Cross-site scripting via improper HTML escaping of untrusted input
- **Source** : `Node.js`
- **Fix** : `pnpm up ip-address` (jusqu'à >= `10.1.1`)


---

## 🟢 NOISE filtré (13 CVE)

<details>
<summary>Liste complète (6 groupes — clique pour déplier)</summary>

| Package | Installed | Fix | CVE count | Max score |
|---|---|---|---|---|
| `hono` | 4.12.25 | 4.12.27 | 1 | 6 |
| `next` | 15.5.18 | 16.2.11 | 5 | 6 |
| `qs` | 6.15.1 | 6.15.2 | 1 | 6 |
| `@sigstore/core` | 2.0.0 | 3.2.1 | 1 | 6 |
| `brace-expansion` | 2.0.2 | 5.0.5 | 1 | 6 |
| `tar` | 7.5.11 | 7.5.21 | 4 | 6 |

</details>


---

## Comment réagir

1. **Tu fixes** → bump la dep / la base image, push sur `staging`. Le prochain tick (24h) confirme.
2. **Tu acks le risque** → ajoute un override dans [`veridian-infra/ci/trivy-overrides.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-overrides.yml) avec date d'expiration + raison.
3. **Tu ignores** → ne fais rien, le tick recréera ce fichier demain à l'identique.

> Tu peux **supprimer ce fichier librement**. Il sera recréé au prochain tick s'il reste des items à signaler. C'est l'idempotence qui garantit qu'on ne perd rien.

*Pour ajuster les règles : [`veridian-infra/ci/trivy-scoring.yml`](https://github.com/Christ-Roy/veridian-infra/blob/main/ci/trivy-scoring.yml). Ping infra-agent.*
