# [HUB] E2E — durcir les tolérances pourries (S7 + audit complet)

> **Sévérité** : 🟡 P1 — tolérances 503/502 masquent les vrais bugs Stripe en staging
> **Owner** : sub-agent Opus dédié
> **Créé** : 2026-05-23 par team lead après vrai bug Stripe head_office masqué

## Contexte

Le 2026-05-23, vrai bug Stripe staging (`head_office: null` côté preprod → `automatic_tax` rejetait `stripe_session_failed`) **n'a pas été détecté** par la suite E2E pendant ~6h car le test `e2e/staging-full/12-stripe-billing-flow.spec.ts:179` (S7) avait :

```ts
expect([200, 502, 503]).toContain(res.status());
```

= tolère 502/503 comme si c'était normal en staging. Conséquence : **checkout réel pété en silence, aucun signal CI/E2E**.

Bug trouvé manuellement via Stripe Tax API + fix posé via `/v1/tax/settings` POST head_office. Maintenant checkout marche, mais on doit s'assurer que ce genre de tolérance pourrie **n'existe plus nulle part**.

## Mission

### Phase 1 — Durcir spec 12 S7

`e2e/staging-full/12-stripe-billing-flow.spec.ts:179` (test S7) :

**Avant** :
```ts
expect([200, 502, 503]).toContain(res.status());
const body = await res.json();
if (res.status() === 200) {
  expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
} else if (res.status() === 503) {
  expect(body.error).toBe('stripe_price_not_configured');
}
```

**Après** : doit retourner 200 + URL valide. Point. Plus de fallback 503 accepté maintenant que Stripe TEST est configuré.

```ts
const body = await res.text();
expect(res.status(), `Checkout doit retourner 200, sinon Stripe est cassé. Body: ${body}`).toBe(200);
const data = JSON.parse(body);
expect(data.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
expect(typeof data.session_id).toBe('string');
```

### Phase 2 — Audit toutes les tolérances `toContain([200, 4xx/5xx])` dans `e2e/staging-full/*.spec.ts`

Pour chaque match :
1. Identifier si la tolérance cache un vrai bug potentiel (5xx surtout) ou est légitime (ex: 429 lors d'un rate-limit volontairement testé)
2. Durcir au cas par cas :
   - **Tolère 5xx** → durcir, exiger comportement précis (200 OU erreur métier propre 4xx avec body explicite)
   - **Tolère 429 sur un rate-limit volontaire** → garder
   - **Tolère 401/403 sur auth** → garder
3. Pour chaque tolérance retirée, vérifier que le test passe encore en staging actuel (sinon poser ticket pour fixer le vrai bug derrière)

### Phase 3 — Convention `expect([...]).toContain(status)` est un anti-pattern

Ajouter dans `e2e/staging-full/README.md` (ou créer) :

```md
## Anti-pattern : tolérance multi-status

❌ NE PAS écrire `expect([200, 5xx]).toContain(res.status())` — ça masque
les vrais bugs. Si le test peut légitimement renvoyer plusieurs statuts,
**brancher selon l'état attendu** (with comment why), pas tolérer en silence.

✅ Pattern correct :
- Status unique attendu → `expect(res.status()).toBe(200)`
- Branch légitime (e.g. rate-limit volontaire) → `if (rate-limit dispo) expect(200); else expect(429)`
- Erreur métier acceptable → assert le body.error précisément
```

### Phase 4 — Ajouter un test "Stripe Tax head_office présent" anti-régression

Spec dédiée `e2e/staging-full/12bis-stripe-account-config.spec.ts` qui hit `/v1/tax/settings` Stripe API et asserte :
- `status === 'active'`
- `head_office.address.country === 'FR'`
- `head_office.address.postal_code` non-vide

Si une régression remet `head_office: null` (rotation compte, reset env), ce test pète immédiatement.

## Définition of done

- [ ] Spec 12 S7 durcie
- [ ] Audit complet `toContain` tolérances pourries fait (liste ces patterns + fix)
- [ ] Convention documentée
- [ ] Nouveau test anti-régression `head_office`
- [ ] `pnpm e2e:staging:full` passe à >= run précédent (132/150)
- [ ] Marker commit `[risk:medium]` (touche tests E2E + ajoute coverage)
- [ ] Stop sur staging

## Contraintes

- Pas de touche au code Hub source — uniquement tests E2E
- Rebase systématique avant push (les 2 autres agents bypass-signup + race-condition peuvent être actifs)
- DEPLOY_ENV (jamais NODE_ENV)
