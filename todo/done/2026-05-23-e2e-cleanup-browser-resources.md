# [HUB] E2E — cleanup browser/context après chaque spec (anti-fuite ressources)

> **Sévérité** : 🟡 P1 — fuite mémoire local après run E2E
> **Owner** : sub-agent Opus dédié
> **Créé** : 2026-05-23

## Contexte

Après run `pnpm e2e:staging:full` du 2026-05-23, **49 processus Chromium étaient encore vivants** sur la machine locale (consomment RAM + sockets). Playwright devrait normalement cleanup auto en fin de run mais ça ne se passe pas correctement.

## Causes probables

1. **Specs qui font `browser.newContext()` sans `context.close()`** dans `afterEach`
2. **Specs qui font `browser.newPage()` sans `page.close()`** explicite
3. **Sub-process orphelins** quand un timeout brutalement coupe Playwright sans cleanup
4. **`slowMo: 150` en mode headed** laisse les windows visibles → si l'user ne ferme pas, les browsers restent
5. **`workers: 1` + retries: 1** — un retry sur timeout peut leak le browser du premier essai

## Action attendue

### Phase 1 — Audit (15 min)

```bash
grep -L "afterEach\|afterAll" e2e/staging-full/*.spec.ts
# → liste des specs SANS hook cleanup explicite
```

Pour chaque spec sans cleanup :
- Vérifier si elle utilise `browser.newContext()` ou `browser.newPage()`
- Si oui : ajouter le cleanup

### Phase 2 — Pattern global dans `playwright.staging-full.config.ts`

Ajouter un `globalTeardown` qui tue tous les browser processes en fin de run :

```ts
// playwright.staging-full.config.ts
globalTeardown: require.resolve('./e2e/staging-full/_global-teardown.ts'),
```

Créer `e2e/staging-full/_global-teardown.ts` :

```ts
import { execSync } from 'node:child_process';

export default async function globalTeardown() {
  // Kill any leftover chromium processes that escaped Playwright cleanup
  try {
    execSync('pkill -9 -f "chromium.*--remote-debugging-pipe" || true', {
      stdio: 'ignore',
    });
  } catch {
    // ignore — best effort
  }
}
```

### Phase 3 — Hook helper réutilisable

Créer `e2e/staging-full/_cleanup-helper.ts` avec un export `withCleanContext` que toutes les specs utilisent à la place de `browser.newContext()` direct, garantissant le cleanup même en cas d'erreur.

### Phase 4 — Documentation

Ajouter dans `CI-ARCHITECTURE.md` §20 ou nouveau fichier `docs/E2E-RUNBOOK.md` :
- Comment lancer les E2E proprement
- Comment vérifier qu'aucun browser n'a leak après (`pgrep chromium | wc -l` doit retourner 0)
- Comment cleaner manuellement si fuite : `pkill -9 -f chromium`

## Définition of done

- [ ] Toutes les specs `e2e/staging-full/*.spec.ts` ont un `afterEach` ou `afterAll` qui ferme contexts/pages
- [ ] `globalTeardown` ajouté à `playwright.staging-full.config.ts`
- [ ] `_global-teardown.ts` créé
- [ ] Run `pnpm e2e:staging:full` puis `pgrep -c chromium` = 0
- [ ] Doc runbook E2E à jour
- [ ] Push staging

## Contraintes

- Marker commit `[risk:low]` (test infra)
- Pas de touche au code Hub
- Stop sur staging
