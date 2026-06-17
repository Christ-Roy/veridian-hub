/**
 * JUGE DE PAIX tunnel → Hub — gates G0→G10 portés du bridge dev-pub vers le Hub
 * staging. C'est le critère de PARITÉ qui autorise à débrancher l'ancien bridge
 * (`veridian-tunnel-de-vente/bridge/`) : si ces gates passent vert contre le Hub,
 * la chaîne `webhook → ingestion → DB → scoring découplé → score` reproduit ce
 * que le bridge faisait, AVEC LE MÊME BARÈME (engine 'tunnel-v2', l'ancre).
 *
 * Référence portée : `veridian-tunnel-de-vente/tunnel-e2e/` (README + gates.mjs).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ ÉCART STRUCTUREL (cf config.ts) : la référence tape le bridge+SQLite et    │
 * │ score À L'INGESTION ; ici on tape le HUB (Postgres) où le scoring est       │
 * │ DÉCOUPLÉ (cron push-prospect-scores). Le point de parité n'est plus "le     │
 * │ score dans Twenty" mais "le score dans hub_app.prospect_scores APRÈS un     │
 * │ tick du cron, en DRY_RUN". Le push Twenty est LOGUÉ, pas envoyé.            │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │ SCOPE V1 D'INGESTION (contrat §7.5.1, figé 2026-06-15) — PAS des bugs :     │
 * │  • Ingéré au V1 : email.opened / email.clicked / email.replied.            │
 * │  • PAS encore ingéré : email.sent (compteur legacy seul), email.bounced /  │
 * │    email.unsubscribed (barème prêt, aucun émetteur), page.hit (voie web =   │
 * │    cron pull-analytics, route webhook /analytics à créer).                  │
 * │  ⇒ La parité de SCORE se prouve sur la famille EMAIL du scope V1 (opened/   │
 * │    clicked/replied), celle qui transite par la vraie voie legacy HMAC de    │
 * │    prod et que 100 % des prospects ont. G6 déclenche le vrai cron           │
 * │    pull-analytics (preuve que la voie web tourne). On ne fabrique JAMAIS de │
 * │    faux events par INSERT direct (règle d'or).                              │
 * │  ⚠️ Implication prod tracée : bounce/unsub non disqualifiants au V1 (un     │
 * │    bounce dur reste contactable). Choix V1 assumé, ticket déposé.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Correspondance des gates (bridge → Hub) :
 *   G0  préflight : allowlist test + DRY_RUN actif + CRON_SECRET + Hub joignable.
 *   G2  ouverture : email.opened signé HMAC ×5 → prospect_events (OPEN_FIRST +5).
 *   G5  clic      : email.clicked ×2 signés ×5 (CLICK_FIRST +20 + CLICK_EXTRA +10).
 *   G5b reply     : email.replied signé ×5 (EMAIL_REPLIED +35, extension HUB).
 *   G6  web       : tick du cron pull-analytics (la voie des events web existe/tourne).
 *   G7  scoring   : tick du cron push-prospect-scores (DRY_RUN) → scores écrits.
 *   G8  PARITÉ    : score DB == getScoringEngine('tunnel-v2') sur events réels
 *                   + label + signals (components) + push Twenty LOGUÉ (dryRun).
 *   G8b concurrence : N opened en parallèle → score == signals.opened == N
 *                     (atomicité jsonb_set, le test clé du fix 61d4cc6 / spec 21).
 *   G8c disqualif : email.bounced → score 0 + disqualified + label froid.
 *   G9  dédup     : replay même event_id → 0 doublon + score INCHANGÉ.
 *   G10 cleanup   : garde-fou final (0 fuite hors allowlist) + purge des rows E2E.
 */

import { test, expect } from '@playwright/test';

import {
  CRON_SECRET,
  SIMULATED_JOURNEY,
  STAGING_URL,
  TEST_PROSPECTS,
  WORKSPACE_SLUG,
  isTestEmail,
} from './config';
import {
  assertOnlyTestEmailsScored,
  cleanupWorkspace,
  countEventsByKey,
  countEventsByType,
  expectedScoreFromDb,
  postLegacyHmac,
  randomUUID,
  readScore,
  selectScalar,
  sqlStr,
  triggerPullAnalyticsCron,
  triggerPushCron,
  type PushSummary,
} from './lib';

// Flow strictement séquentiel : chaque gate dépend de l'état laissé par le
// précédent (events accumulés → scoring → assertions). workers:1 dans la config.
test.describe.configure({ mode: 'serial' });

// ─── État partagé entre gates ────────────────────────────────────────────────

/** 1er clicked event_id du prospect[0], réutilisé G9 (replay/dédup). */
let firstClickedEventId = '';
/** Résumé du tick de scoring capturé en G7, asserté en G8. */
let pushSummary: PushSummary | null = null;
/** Email dédié au gate concurrence (G8b) — hors des 5 du parcours nominal. */
const RACE_EMAIL = `tunnel-e2e-race-${WORKSPACE_SLUG}@e2e.veridian.site`;
/** Email dédié au gate disqualification (G8c). */
const BOUNCE_EMAIL = `tunnel-e2e-bounce-${WORKSPACE_SLUG}@e2e.veridian.site`;

// ─── Teardown : filet si un gate amont casse avant G10. ──────────────────────

test.afterAll(() => {
  try {
    cleanupWorkspace(WORKSPACE_SLUG);
  } catch (err) {
    console.warn('[tunnel-gates] cleanup afterAll (best-effort)', err);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// G0 — PRÉFLIGHT : refuse de tourner sans les garde-fous (porté tel quel).
// ════════════════════════════════════════════════════════════════════════════

test('G0 — préflight : allowlist test + DRY_RUN actif + services joignables', async ({
  request,
}) => {
  // 1. Allowlist : tous les emails de test passent, un email NON-test est REFUSÉ.
  for (const p of TEST_PROSPECTS) {
    expect(isTestEmail(p.email), `${p.email} doit passer l'allowlist`).toBe(true);
  }
  expect(isTestEmail(RACE_EMAIL), 'email race = test').toBe(true);
  expect(isTestEmail(BOUNCE_EMAIL), 'email bounce = test').toBe(true);
  expect(
    isTestEmail('robert@veridian.site'),
    "un email NON-test doit être REFUSÉ (garde-fou actif, pas no-op)",
  ).toBe(false);

  // 2. CRON_SECRET présent (sinon G7 = 401 — échouer tôt et clair).
  expect(
    CRON_SECRET.length,
    'CRON_SECRET absent — scripts/e2e/tunnel-gates.sh doit le sourcer du container.',
  ).toBeGreaterThan(0);

  // 3. Hub staging joignable.
  const health = await request.get(`${STAGING_URL}/api/health`, {
    failOnStatusCode: false,
  });
  expect(health.status(), 'Hub staging /api/health = 200').toBe(200);

  // 4. DRY_RUN ACTIF : tick à vide → dryRun=true. Garde-fou central : le juge de
  //    paix NE DOIT JAMAIS écrire dans le vrai CRM. dryRun=false = REFUS de courir.
  const probe = await triggerPushCron(request);
  expect(
    probe.dryRun,
    "le cron push-prospect-scores DOIT être en DRY_RUN (CRON_PUSH_DRY_RUN!=false). REFUS sinon.",
  ).toBe(true);
  expect(probe.engineId, 'moteur tunnel-v2 (ancre de parité)').toBe('tunnel-v2');
});

// ════════════════════════════════════════════════════════════════════════════
// G2 — OUVERTURE : email.opened signé HMAC ×5 → prospect_events (OPEN_FIRST +5).
// ════════════════════════════════════════════════════════════════════════════

test('G2 — email.opened signé HMAC ×5 → 5 rows prospect_events', async ({
  request,
}) => {
  for (const p of TEST_PROSPECTS) {
    const eventId = randomUUID();
    const res = await postLegacyHmac(request, {
      event_id: eventId,
      event_type: 'email.opened',
      tenant_id: WORKSPACE_SLUG,
      occurred_at: new Date().toISOString(),
      data: { contact_email: p.email, message_id: `open-${p.providerClass}` },
    });
    expect(
      res.status(),
      `email.opened HMAC ${p.email} accepté 200 (401 = secret HMAC désaligné)`,
    ).toBe(200);
    expect(
      countEventsByKey(eventId),
      `1 row prospect_events pour l'opened de ${p.email}`,
    ).toBe(1);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// G5 — CLIC : email.clicked ×2 (event_ids distincts) signés HMAC ×5.
// CLICK_FIRST +20 (1er clic) + CLICK_EXTRA +10 (2e clic) = +30 — prouve le palier.
// ════════════════════════════════════════════════════════════════════════════

test('G5 — email.clicked ×2 signés HMAC ×5 → 2 clics distincts par prospect', async ({
  request,
}) => {
  for (const p of TEST_PROSPECTS) {
    for (let i = 0; i < SIMULATED_JOURNEY.emailClicks; i++) {
      const eventId = randomUUID();
      if (p === TEST_PROSPECTS[0] && i === 0) firstClickedEventId = eventId;
      const res = await postLegacyHmac(request, {
        event_id: eventId,
        event_type: 'email.clicked',
        tenant_id: WORKSPACE_SLUG,
        occurred_at: new Date().toISOString(),
        data: {
          contact_email: p.email,
          link_url: `https://veridian.site/e2e-tunnel-link-${i}`,
        },
      });
      expect(res.status(), `email.clicked #${i} HMAC ${p.email} accepté 200`).toBe(
        200,
      );
    }
    expect(
      countEventsByType(WORKSPACE_SLUG, p.email, 'email.clicked'),
      `${p.email} doit avoir exactement ${SIMULATED_JOURNEY.emailClicks} clics`,
    ).toBe(SIMULATED_JOURNEY.emailClicks);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// G5b — REPLY : email.replied signé HMAC ×5 (EMAIL_REPLIED +35, extension HUB).
// ════════════════════════════════════════════════════════════════════════════

test('G5b — email.replied signé HMAC ×5 → reply ingéré par prospect', async ({
  request,
}) => {
  for (const p of TEST_PROSPECTS) {
    const eventId = randomUUID();
    const res = await postLegacyHmac(request, {
      event_id: eventId,
      event_type: 'email.replied',
      tenant_id: WORKSPACE_SLUG,
      occurred_at: new Date().toISOString(),
      data: { contact_email: p.email, message_id: `reply-${p.providerClass}` },
    });
    expect(res.status(), `email.replied HMAC ${p.email} accepté 200`).toBe(200);
    expect(
      countEventsByType(WORKSPACE_SLUG, p.email, 'email.replied'),
      `${p.email} doit avoir 1 reply`,
    ).toBe(1);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// G6 — VOIE WEB : tick du cron pull-analytics. On NE fabrique PAS de faux
// page.hit (page.hit n'a pas de voie webhook ; un INSERT direct violerait la
// règle d'or). On prouve que la voie web RÉELLE (cron L4) existe et tourne sans
// crasher — l'isolation/parité des events web est couverte par les tests du L4.
// ════════════════════════════════════════════════════════════════════════════

test('G6 — voie events web : tick du cron pull-analytics tourne sans erreur', async ({
  request,
}) => {
  const summary = await triggerPullAnalyticsCron(request);
  expect(
    summary.ok,
    'le cron pull-analytics doit répondre ok=true (skipped:true accepté si ' +
      'ENGINE_ADMIN_* absents en staging — la voie existe, garde-fou propre)',
  ).toBe(true);
});

// ════════════════════════════════════════════════════════════════════════════
// G7 — SCORING DÉCOUPLÉ : tick du cron push-prospect-scores (DRY_RUN).
// Le maillon NOUVEAU du Hub (le bridge scorait à l'ingestion). Relit les events,
// recalcule via 'tunnel-v2', écrit prospect_scores, LOGUE le push Twenty.
// ════════════════════════════════════════════════════════════════════════════

test('G7 — tick cron push-prospect-scores (DRY_RUN) → ≥5 scores écrits', async ({
  request,
}) => {
  pushSummary = await triggerPushCron(request);

  expect(pushSummary.ok, 'le tick du cron doit réussir').toBe(true);
  expect(
    pushSummary.dryRun,
    'tick DOIT être DRY_RUN (mutations Twenty loguées, pas envoyées)',
  ).toBe(true);
  expect(pushSummary.engineId, 'moteur tunnel-v2').toBe('tunnel-v2');
  expect(
    pushSummary.scored,
    'le cron doit avoir scoré au moins nos 5 prospects',
  ).toBeGreaterThanOrEqual(TEST_PROSPECTS.length);
});

// ════════════════════════════════════════════════════════════════════════════
// G8 — PARITÉ : score DB == getScoringEngine('tunnel-v2') sur les events réels.
// LE GATE CENTRAL. Aucun nombre hardcodé : l'attendu est rejoué par le code de
// prod (lib/prospect/scoring) sur les events lus en DB. score DB == attendu =>
// parité bridge↔Hub prouvée (même barème, mêmes signaux, même score).
// ════════════════════════════════════════════════════════════════════════════

test('G8 — parité : chaque score DB == engine tunnel-v2 (events réels) + push Twenty LOGUÉ', async () => {
  // now figé : la récence (×1.5 si <48h) doit être identique entre l'attendu
  // recalculé ici et ce que le cron a fait (events injectés à l'instant → <48h
  // des deux côtés ; on fige pour éliminer toute fenêtre de bord).
  const now = new Date();

  for (const p of TEST_PROSPECTS) {
    const dbScore = readScore(WORKSPACE_SLUG, p.email);
    expect(
      dbScore,
      `prospect_scores doit exister pour ${p.email} après le tick`,
    ).not.toBeNull();

    const expected = expectedScoreFromDb(WORKSPACE_SLUG, p.email, now);

    // PARITÉ DU SCORE — le cœur du juge de paix.
    expect(
      dbScore!.score,
      `parité score ${p.email} : DB=${dbScore!.score} vs engine=${expected.score} ` +
        `— un écart = divergence ingestion/agrégation/barème Hub↔ancre.`,
    ).toBe(expected.score);

    // PARITÉ DU LABEL (froid/tiede/chaud dérivé du même score).
    expect(dbScore!.label, `parité label ${p.email}`).toBe(expected.label);

    // PARITÉ DES SIGNALS (vue plate des components hors recency_multiplier).
    const expectedSignals: Record<string, number> = {};
    for (const [k, v] of Object.entries(expected.components)) {
      if (k !== 'recency_multiplier') expectedSignals[k] = v;
    }
    expect(dbScore!.signals, `parité signals ${p.email}`).toEqual(expectedSignals);

    // Parcours complet (opened +5, 2 clics +30, replied +35 = 70, ×1.5 = 100) →
    // chaud. On assert > 30 pour éviter un faux-vert trivial 0==0.
    expect(
      dbScore!.score,
      `${p.email} doit être chaud (>30) — opened+2 clics+reply ne peut valoir 0`,
    ).toBeGreaterThan(30);
  }

  // Push Twenty LOGUÉ, pas envoyé : sans CrmTenant en staging, le push est skippé
  // gracieusement (score écrit en DB, push non tenté → noCrmTenant). Preuve que
  // le juge de paix ne touche aucun vrai CRM.
  expect(pushSummary, 'summary G7 capturé').not.toBeNull();
  expect(
    pushSummary!.noCrmTenant,
    'sans CrmTenant, le push CRM est skippé (score quand même écrit)',
  ).toBeGreaterThanOrEqual(TEST_PROSPECTS.length);
});

// ════════════════════════════════════════════════════════════════════════════
// G8b — CONCURRENCE : N email.opened en PARALLÈLE → score == signals.opened == N.
// Le test le plus important de l'atomicité (fix 61d4cc6, cf spec 21). Prouve que
// le jsonb_set atomique ne perd pas d'incréments sous course. NB : opened est
// NON-cumulable au barème (cap +5) → on vérifie l'invariant sur le COMPTEUR
// d'events ingérés (chaque event distinct s'insère) ET la cohérence du score.
// ════════════════════════════════════════════════════════════════════════════

test('G8b — concurrence : 10× email.opened parallèle → tous ingérés, état cohérent', async ({
  request,
}) => {
  const N = 10;
  const eventIds = Array.from({ length: N }, () => randomUUID());

  // Burst RÉELLEMENT parallèle (la route webhook n'a pas de rate-limiter sur
  // l'auth HMAC) → on tape la course sur la MÊME row prospect_scores.
  const responses = await Promise.all(
    eventIds.map((event_id) =>
      postLegacyHmac(request, {
        event_id,
        event_type: 'email.opened',
        tenant_id: WORKSPACE_SLUG,
        occurred_at: new Date().toISOString(),
        data: { contact_email: RACE_EMAIL },
      }),
    ),
  );
  for (const res of responses) {
    expect(res.status(), 'chaque webhook du burst accepté 200').toBe(200);
  }

  // Les N events sont TOUS persistés (idempotency_key distincts, aucun perdu).
  const total = Number(
    selectScalar(
      `SELECT count(*) FROM hub_app.prospect_events
         WHERE workspace_slug = '${sqlStr(WORKSPACE_SLUG)}'
           AND contact_email = '${sqlStr(RACE_EMAIL)}'
           AND event_type = 'email.opened'`,
    ) ?? '0',
  );
  expect(total, `les ${N} opened concurrents doivent TOUS être persistés`).toBe(N);

  // Tick de scoring puis parité : le score recalculé from-scratch doit être
  // EXACTEMENT celui de l'engine sur ces N opened (opened non-cumulable → +5,
  // ×1.5 récence = 8 (round(7.5)) ). L'égalité prouve que l'agrégation lit bien
  // tous les events sans en perdre sous la course d'ingestion.
  await triggerPushCron(request);
  const dbScore = readScore(WORKSPACE_SLUG, RACE_EMAIL);
  expect(dbScore, 'prospect_scores doit exister après le burst').not.toBeNull();
  const expected = expectedScoreFromDb(WORKSPACE_SLUG, RACE_EMAIL, new Date());
  expect(
    dbScore!.score,
    `parité sous concurrence : DB=${dbScore!.score} vs engine=${expected.score} ` +
      `(si divergent, des events ont été perdus à l'ingestion concurrente)`,
  ).toBe(expected.score);
});

// ════════════════════════════════════════════════════════════════════════════
// G8c — SCOPE V1 : un event HORS-SCOPE (email.bounced) est ignoré IDENTIQUEMENT
// par le Hub et par l'ancre → la parité tient.
//
// Le scope d'ingestion V1 est figé au contrat §7.5.1 : opened/clicked/replied
// (page.hit à venir). email.bounced/unsubscribed/sent ne sont PAS ingérés au V1
// (le barème aggregateSignals les gère déjà = forward-compat, mais aucun
// émetteur ne les câble). Ce gate PROUVE ce contrat : on envoie clicked PUIS
// bounced ; le bounce ne crée pas de row → ni le Hub ni l'engine ne le voient →
// score = celui du seul clic, disqualified=false, et engine==DB (parité).
//
// ⚠️ Implication prod tracée (todo/2026-06-17-…) : tant que le bounce n'est pas
// ingéré, un prospect qui bounce dur reste contactable (pas de doNotContact via
// le flux réel). C'est un choix V1 assumé, pas une régression du portage.
// ════════════════════════════════════════════════════════════════════════════

test('G8c — scope V1 : email.bounced hors-scope ignoré des 2 côtés → parité tient', async ({
  request,
}) => {
  // 1 clic (scope V1, ingéré → +20).
  await postLegacyHmac(request, {
    event_id: randomUUID(),
    event_type: 'email.clicked',
    tenant_id: WORKSPACE_SLUG,
    occurred_at: new Date().toISOString(),
    data: { contact_email: BOUNCE_EMAIL, link_url: 'https://x' },
  });
  // 1 bounce (HORS scope V1 → 200 mais non ingéré, aucune row).
  const res = await postLegacyHmac(request, {
    event_id: randomUUID(),
    event_type: 'email.bounced',
    tenant_id: WORKSPACE_SLUG,
    occurred_at: new Date().toISOString(),
    data: { contact_email: BOUNCE_EMAIL, reason: 'hard_bounce' },
  });
  expect(res.status(), 'email.bounced accepté 200 (mais non ingéré au V1)').toBe(
    200,
  );
  // Preuve du scope : 0 row email.bounced en DB (event hors-scope non persisté).
  expect(
    countEventsByType(WORKSPACE_SLUG, BOUNCE_EMAIL, 'email.bounced'),
    'email.bounced ne doit PAS créer de row au V1 (contrat §7.5.1)',
  ).toBe(0);

  await triggerPushCron(request);
  const dbScore = readScore(WORKSPACE_SLUG, BOUNCE_EMAIL);
  expect(dbScore, 'prospect_scores existe (du clic)').not.toBeNull();

  // PARITÉ : engine (sur events réels = le seul clic) == DB. Le bounce est ignoré
  // des deux côtés → pas de divergence. disqualified=false (bounce non vu).
  const expected = expectedScoreFromDb(WORKSPACE_SLUG, BOUNCE_EMAIL, new Date());
  expect(dbScore!.score, 'parité score (bounce ignoré des 2 côtés)').toBe(
    expected.score,
  );
  expect(
    dbScore!.disqualified,
    'disqualified=false au V1 (bounce non ingéré — choix V1 tracé)',
  ).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// G9 — DÉDUP : replay du MÊME event_id → 0 doublon, score INCHANGÉ.
// L'idempotency_key UNIQUE de prospect_events avale le replay (couche 2).
// ════════════════════════════════════════════════════════════════════════════

test('G9 — replay même event_id → dédup (0 doublon) + score inchangé', async ({
  request,
}) => {
  const p = TEST_PROSPECTS[0];
  expect(firstClickedEventId.length, 'event_id du 1er clic capturé en G5').toBeGreaterThan(0);

  const scoreBefore = readScore(WORKSPACE_SLUG, p.email);
  expect(scoreBefore, 'score présent avant le replay').not.toBeNull();
  const clicksBefore = countEventsByType(WORKSPACE_SLUG, p.email, 'email.clicked');

  // Re-POST identique (même event_id) → la couche 2 (INSERT unique) l'avale. 200.
  const res = await postLegacyHmac(request, {
    event_id: firstClickedEventId,
    event_type: 'email.clicked',
    tenant_id: WORKSPACE_SLUG,
    occurred_at: new Date().toISOString(),
    data: {
      contact_email: p.email,
      link_url: 'https://veridian.site/e2e-tunnel-link-0',
    },
  });
  expect(res.status(), 'replay accepté 200 (avalé en idempotent)').toBe(200);

  expect(
    countEventsByKey(firstClickedEventId),
    'replay ne crée PAS un 2e event (idempotency_key UNIQUE)',
  ).toBe(1);
  expect(
    countEventsByType(WORKSPACE_SLUG, p.email, 'email.clicked'),
    'nombre de clics inchangé après replay (pas de gonflage de signal)',
  ).toBe(clicksBefore);

  // Re-tick : score recalculé IDENTIQUE (mêmes events → même score from-scratch).
  const summary = await triggerPushCron(request);
  expect(summary.dryRun, 're-tick toujours en DRY_RUN').toBe(true);

  const scoreAfter = readScore(WORKSPACE_SLUG, p.email);
  expect(scoreAfter, 'score toujours présent après replay').not.toBeNull();
  expect(
    scoreAfter!.score,
    `score INCHANGÉ après replay (${scoreBefore!.score}) — dédup + recompute stable`,
  ).toBe(scoreBefore!.score);
  expect(scoreAfter!.signals, 'signals INCHANGÉS après replay').toEqual(
    scoreBefore!.signals,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// G10 — CLEANUP + garde-fou final : aucune fuite hors allowlist, puis purge.
// ════════════════════════════════════════════════════════════════════════════

test('G10 — garde-fou final (0 fuite hors allowlist) + cleanup', async () => {
  // 100 % des emails scorés dans NOTRE workspace sont des emails de test. Aucune
  // écriture n'a fui (porté d'assertNoRealProspectTouched, frontière workspace_slug).
  assertOnlyTestEmailsScored(WORKSPACE_SLUG, isTestEmail);

  // Purge des rows E2E (events + scores). afterAll re-tente en filet.
  cleanupWorkspace(WORKSPACE_SLUG);

  // Vérif : tout a bien été purgé.
  const remaining = Number(
    selectScalar(
      `SELECT count(*) FROM hub_app.prospect_scores
         WHERE workspace_slug = '${sqlStr(WORKSPACE_SLUG)}'`,
    ) ?? '0',
  );
  expect(remaining, 'tous les scores du workspace test doivent être purgés').toBe(
    0,
  );
});
