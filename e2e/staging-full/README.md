# E2E `staging-full` — conventions & anti-patterns

Suite Playwright "headfull fidelity" qui tape `hub.staging.veridian.site`
avec de vrais downstreams (Stripe TEST, Notifuse staging, etc.). Lancée
manuellement par l'agent via `pnpm e2e:staging:full` avant de poser une
reco de promotion prod (cf. `CI-ARCHITECTURE.md` §20.6/20.7).

## Cible des assertions

- **Status codes** : on assert **strict** quand on connaît la réponse
  attendue. Pas de tolérance large "au cas où".
- **Body shape** : on assert tout ce qui est documenté côté contrat
  (`docs/CONTRAT-HUB.md`). Si un champ apparaît systématiquement, il est
  load-bearing → on l'assert.
- **Invariants sécu** : on assert systématiquement les invariants
  négatifs (`.not.toBe(200)` sur les routes auth, `.not.toContain('user
  not found')` sur les routes d'énumération, etc.).

## Anti-pattern : tolérance multi-status

NE PAS écrire `expect([200, 5xx]).toContain(res.status())`. Ce pattern
**masque les vrais bugs** : on a perdu 6h le 2026-05-23 sur un
`head_office: null` côté Stripe preprod parce que le test S7 de
`12-stripe-billing-flow.spec.ts` tolérait `[200, 502, 503]` → checkout
réel pété en silence, aucun signal CI/E2E.

### Mauvais

```ts
// Cache un vrai bug Stripe / Hub derrière le 503.
expect([200, 502, 503]).toContain(res.status());
const body = await res.json();
if (res.status() === 200) {
  expect(body.url).toMatch(/stripe/);
} else if (res.status() === 503) {
  expect(body.error).toBe('stripe_price_not_configured');
}
```

### Bon — status unique attendu

```ts
const bodyText = await res.text();
expect(
  res.status(),
  `Stripe doit retourner 200, sinon vrai bug. Body: ${bodyText.slice(0, 500)}`,
).toBe(200);
const data = JSON.parse(bodyText);
expect(data.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
```

### Bon — branche métier explicite

Quand le serveur peut légitimement renvoyer plusieurs status (e.g.
rate-limit volontairement testé, downstream tiers réellement HS), on
**branche explicitement** avec un commentaire qui justifie chaque cas :

```ts
// Acceptable : 200 (succès Hub), 502 (Notifuse downstream HS staging).
// Tout le reste = bug : 500 = Hub crash, 4xx = mauvais payload.
expect([200, 202, 502]).toContain(res.status());
expect(
  res.status(),
  'INVARIANT : Hub ne doit JAMAIS crash 500 en gérant le downstream',
).not.toBe(500);
```

### Cas légitimes où tolérer plusieurs status

- **Rate-limit volontairement testé** : `expect([200, 429]).toContain(...)`
  avec une raison documentée.
- **Auth multi-statut** : `expect([401, 403]).toContain(...)` quand la
  route peut renvoyer 401 (pas de session) ou 403 (session mais pas le
  rôle).
- **Erreur métier multi-code Zod** : `expect(['invalid_payload',
  'unknown_plan']).toContain(body.error)` quand l'ordre des validations
  Zod peut donner l'un ou l'autre. **C'est une tolérance sur le body,
  pas sur le status code** → toujours OK.
- **Redirect chain Auth.js** : `expect([200, 302, 307]).toContain(...)`
  sur les routes qui peuvent rendre HTML ou redirect selon la session.

### Cas où on NE DOIT JAMAIS tolérer 5xx

- Routes Stripe Checkout (S7 spec 12) — un 5xx = vrai bug Stripe ou Hub.
- Webhooks sans auth — doit être 4xx strict (un 500 = config Hub cassée).
- Endpoints admin avec secret valide — doit être 2xx/4xx selon payload,
  un 5xx = bug Hub.

## Tester le compte Stripe lui-même

`12bis-stripe-account-config.spec.ts` asserte la config compte Stripe TEST
côté API directement (`STRIPE_SECRET_KEY_TEST`) :

- `tax.settings.status === 'active'`
- `head_office.address.country === 'FR'`

Si une régression remet `head_office: null` (rotation compte, reset env),
ce test pète **immédiatement** au lieu de masquer le bug derrière une
tolérance 503.

## Pourquoi cette suite est cruciale

- Tourne sur de **vrais downstreams** (pas de mock) → détecte les bugs
  d'intégration que les unit tests Vitest manquent.
- Trigger manuel agent uniquement → on peut se permettre des assertions
  strictes (pas de flake "downstream HS aléatoire" toléré).
- Sert de référence pour la reco écrite de promotion prod (§20.7).

## Ajouter un nouveau spec

1. Numéroter en suivant la séquence (`17-...`).
2. Header JSDoc qui documente : pourquoi le test existe, ce qu'il couvre,
   les invariants critiques.
3. Utiliser les helpers de `_helpers.ts` (`uniqueEmail`, `freshIpHeader`,
   `withRateLimitRetry`, `adminHeaders`).
4. Pas de `expect([200, 5xx]).toContain(...)` — relire ce README.
5. Si tu lances un browser à la main (`playwright.chromium.launch()`),
   utiliser `withCleanBrowser` / `withCleanContext` de `_cleanup-helper.ts`
   ou wrapper dans un `try { ... } finally { browser.close() }`. Sinon →
   leak chromium en cas d'assert qui pète. Cf. section "Cleanup ressources"
   ci-dessous.

## Cleanup ressources (anti-fuite chromium)

### Lancer les E2E proprement

```bash
HEADED=0 STAGING_URL=https://hub.staging.veridian.site pnpm e2e:staging:full
```

Le `HEADED=0` désactive le slowMo + lance en headless (plus rapide, pas
de fenêtre qui reste ouverte).

### Vérifier qu'aucun chromium n'a leak après le run

```bash
pgrep -c chromium
# → doit retourner 0 (ou ton compte de Chrome quotidien si tu l'utilises)
```

Le `globalTeardown` de `playwright.staging-full.config.ts` pkill les
chromiums avec `--remote-debugging-pipe` (signature Playwright) en fin de
run. Le Chrome quotidien de l'utilisateur (`--remote-debugging-port`) est
épargné.

### Cleanup manuel si fuite (incident)

```bash
# Tuer uniquement les chromiums Playwright (safe, n'affecte pas Chrome quotidien)
pkill -9 -f "chromium.*--remote-debugging-pipe"

# Nuclear : tuer TOUS les chromiums (ferme Chrome utilisateur aussi)
pkill -9 -f chromium
```

### Pattern correct quand on lance un browser à la main

Préférer le helper réutilisable :

```ts
import { withCleanBrowser, withCleanContext } from './_cleanup-helper';

test('mon flow', async ({ playwright }) => {
  await withCleanBrowser(playwright, async (browser) => {
    await withCleanContext(browser, { baseURL: STAGING_URL, storageState }, async (context) => {
      const page = await context.newPage();
      await page.goto('/dashboard');
      // ... assertions
      // browser + context fermés même si une assert pète
    });
  });
});
```

Ou à défaut, un try/finally manuel :

```ts
const browser = await playwright.chromium.launch();
try {
  // ...
} finally {
  await browser.close().catch(() => {});
}
```

**Anti-pattern** (vu en prod 2026-05-23, a causé 49 chromium leftover) :

```ts
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
await page.goto('...');
expect(...);          // ← si ça pète ici, browser jamais fermé
await browser.close(); // ← jamais atteint
```
