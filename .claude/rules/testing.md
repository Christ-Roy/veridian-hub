---
paths:
  - "prospection/**"
  - "hub/**"
---

# Testing

- Toute nouvelle feature = un test (e2e Playwright ou unit Vitest).
- JAMAIS de signup Supabase en e2e staging ou prod. Login avec compte existant.
- JAMAIS d'appel Supabase admin API dans un hot path. Cache obligatoire (TTL 5min).
- Prospection : `cd prospection && npm test` (vitest) + `npx playwright test` (e2e chromium).
- Hub : `cd hub && pnpm test` (vitest).
- Avant push : `npm run build` doit passer dans les 2 apps modifiees.
