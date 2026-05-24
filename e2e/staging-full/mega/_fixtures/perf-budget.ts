/**
 * MEGA fixture — `perf-budget.ts`
 *
 * Mesure la latence d'une fonction async (typiquement un `fetch`) sur
 * N samples et asserte que p50/p95/p99 respectent un budget temps.
 *
 * **POURQUOI** : le bucket L (Performance budgets) doit garantir que
 * les endpoints critiques tiennent leur SLO :
 *   - GET /api/billing/state (cache HIT) : p95 < 100ms
 *   - GET /api/users/by-email : p95 < 200ms
 *   - POST /api/billing/checkout : p95 < 2s
 *   - POST /api/cron/trial-tick : p95 < 5s
 *   - POST /api/webhooks (cold path) : p95 < 1s
 *
 * **API** :
 *
 *   const samples = await measure({
 *     iterations: 50,
 *     warmup: 5,
 *     fn: () => fetch('/api/billing/state'),
 *   });
 *   assertBudget(samples, { p50: 50, p95: 100, p99: 200 });
 *
 * **WARMUP** : les premiers calls sont systématiquement plus lents
 * (cold cache, JIT warmup, TCP slow-start). On les exclut du calcul
 * via `warmup: N` (skip les N premiers samples).
 *
 * **PRÉCISION** : `performance.now()` est précis ms en Node 20+.
 * Suffisant pour des budgets > 10ms. Pour des budgets sub-ms (micro-
 * benchmark), passer à `process.hrtime.bigint()`.
 */

export interface MeasureOpts {
  /** Nombre total d'itérations (warmup inclus). Défaut 50. */
  iterations?: number;
  /** Nombre d'itérations de warmup à exclure du calcul. Défaut 3. */
  warmup?: number;
  /** Fonction à mesurer (doit retourner une Promise). */
  fn: () => Promise<unknown>;
  /** Délai entre 2 calls (ms). Défaut 0 (back-to-back). Utile pour
   *  éviter de tape le rate-limit pendant la mesure. */
  delayMs?: number;
}

export interface LatencyStats {
  /** Tous les samples (en ms), warmup exclus, ordre chronologique. */
  samples: number[];
  /** Médiane (p50). */
  p50: number;
  /** 95e percentile. */
  p95: number;
  /** 99e percentile. */
  p99: number;
  /** Min observé. */
  min: number;
  /** Max observé. */
  max: number;
  /** Moyenne arithmétique. */
  mean: number;
  /** Nombre de samples effectivement utilisés (post-warmup). */
  count: number;
}

/**
 * Exécute la fonction `fn` N fois et retourne les stats de latence.
 */
export async function measure(opts: MeasureOpts): Promise<LatencyStats> {
  const iterations = opts.iterations ?? 50;
  const warmup = opts.warmup ?? 3;
  const delayMs = opts.delayMs ?? 0;

  if (warmup >= iterations) {
    throw new Error(
      `[mega/perf-budget] warmup (${warmup}) doit être < iterations (${iterations})`,
    );
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      await opts.fn();
    } catch (err) {
      // Le perf budget ne doit pas masquer un fail métier. Si la fn
      // throw, on remonte l'erreur (le caller wrappe lui-même si besoin).
      throw new Error(
        `[mega/perf-budget] fn throw à l'itération ${i + 1}/${iterations}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const elapsed = performance.now() - start;
    if (i >= warmup) {
      samples.push(elapsed);
    }
    if (delayMs > 0 && i < iterations - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return computeStats(samples);
}

/**
 * Calcule les stats de latence à partir d'un array de samples (ms).
 * Exposé séparément pour réutilisation par les specs qui veulent
 * mesurer eux-mêmes (ex: stress 100 webhooks parallèles).
 */
export function computeStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    throw new Error('[mega/perf-budget] aucun sample fourni (impossible de calculer les stats)');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx];
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samples,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    count: sorted.length,
  };
}

export interface PerfBudget {
  /** Budget p50 en ms. */
  p50?: number;
  /** Budget p95 en ms. */
  p95?: number;
  /** Budget p99 en ms. */
  p99?: number;
  /** Budget max (worst case) en ms. */
  max?: number;
  /** Marge de tolérance en pourcentage. Défaut 20 (+20%). */
  tolerancePct?: number;
}

/**
 * Asserte que les stats respectent le budget (avec marge tolérance).
 * Throw une AssertionError lisible (format Playwright-friendly).
 *
 * Logique tolérance :
 *   - budget.p95 = 100ms, tolerancePct = 20 → seuil effectif = 120ms
 *   - si stats.p95 > 120ms → fail
 *
 * Pourquoi tolérance : Stripe staging a des latences variables, dev
 * server partage les ressources. Un budget strict serait flaky.
 */
export function assertBudget(stats: LatencyStats, budget: PerfBudget, label = 'endpoint'): void {
  const tolerance = (budget.tolerancePct ?? 20) / 100;
  const violations: string[] = [];

  if (budget.p50 !== undefined) {
    const limit = budget.p50 * (1 + tolerance);
    if (stats.p50 > limit) {
      violations.push(
        `p50=${stats.p50.toFixed(1)}ms > ${limit.toFixed(1)}ms (budget ${budget.p50}ms + ${(tolerance * 100).toFixed(0)}%)`,
      );
    }
  }
  if (budget.p95 !== undefined) {
    const limit = budget.p95 * (1 + tolerance);
    if (stats.p95 > limit) {
      violations.push(
        `p95=${stats.p95.toFixed(1)}ms > ${limit.toFixed(1)}ms (budget ${budget.p95}ms + ${(tolerance * 100).toFixed(0)}%)`,
      );
    }
  }
  if (budget.p99 !== undefined) {
    const limit = budget.p99 * (1 + tolerance);
    if (stats.p99 > limit) {
      violations.push(
        `p99=${stats.p99.toFixed(1)}ms > ${limit.toFixed(1)}ms (budget ${budget.p99}ms + ${(tolerance * 100).toFixed(0)}%)`,
      );
    }
  }
  if (budget.max !== undefined) {
    const limit = budget.max * (1 + tolerance);
    if (stats.max > limit) {
      violations.push(
        `max=${stats.max.toFixed(1)}ms > ${limit.toFixed(1)}ms (budget ${budget.max}ms + ${(tolerance * 100).toFixed(0)}%)`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `[mega/perf-budget] ${label} dépasse le budget (n=${stats.count}):\n  ` +
        violations.join('\n  ') +
        `\n  Stats complètes : p50=${stats.p50.toFixed(1)} p95=${stats.p95.toFixed(1)} ` +
        `p99=${stats.p99.toFixed(1)} max=${stats.max.toFixed(1)} mean=${stats.mean.toFixed(1)}`,
    );
  }
}

/**
 * Helper concis pour les specs : measure + assertBudget en une ligne.
 *
 *   await checkPerfBudget({
 *     label: 'GET /api/billing/state',
 *     iterations: 50,
 *     fn: () => fetch(`${url}/api/billing/state`),
 *     budget: { p95: 100, p99: 200 },
 *   });
 */
export async function checkPerfBudget(opts: MeasureOpts & {
  label: string;
  budget: PerfBudget;
}): Promise<LatencyStats> {
  const stats = await measure(opts);
  assertBudget(stats, opts.budget, opts.label);
  return stats;
}
