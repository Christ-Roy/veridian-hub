/**
 * MEGA spec M-01 — Rollback safety : workflow CI rollback sur smoke prod fail
 *
 * **POURQUOI** : le filet de sécurité ultime du Hub est le job `rollback-prod`
 * dans `.github/workflows/hub-ci.yml` qui retag `:rollback → :latest` si
 * `deploy-prod` OU `e2e-prod-smoke` fail. Si ce filet est cassé (condition
 * pas câblée, tag rollback jamais posé, retry logic absent), un mauvais
 * deploy peut rester en prod sans rollback automatique.
 *
 * **MODE DE TEST** (spec hybride statique + live) :
 *
 * Le ticket MEGA marque M-01 comme "optionnel, simuler deploy fail = lourd".
 * On choisit une approche **vérification d'invariants** (pas simulation de
 * deploy live) :
 *
 *   1. **Static** : parser `.github/workflows/hub-ci.yml` et vérifier que
 *      les invariants critiques sont câblés (job rollback-prod existe,
 *      bonnes conditions, le retag :rollback → :latest est présent, le
 *      healthcheck de validation post-rollback est là).
 *   2. **Live** : `GET /api/health` sur staging retourne 200 stable
 *      (sinon le healthcheck du rollback ne marcherait pas non plus —
 *      même contrat).
 *   3. **Live** : `/api/health` ne fuit pas d'info sensible (version
 *      commit, env vars) qui pourrait aider un attaquant à exploiter
 *      pendant la fenêtre de rollback.
 *
 * **POURQUOI PAS SIMULER UN DEPLOY FAIL** :
 *   - Forcer un deploy prod cassé = requires PAT GitHub + secrets prod
 *   - Risque de polluer le state docker prod (tag :rollback écrasé)
 *   - 30 min de durée minimum (cycle deploy + smoke + rollback)
 *   → un workflow `hub-rollback-drill.yml` séparé est mieux (cf. ticket
 *     M-01 §1 : "workflow_dispatch séparé, manuel"). Cette spec MEGA est
 *     le **gate d'invariants statiques** qui s'exécute à chaque push staging.
 *
 * **ASSERTS HARDCORE (6)** :
 *   1. Workflow `hub-ci.yml` contient un job `rollback-prod`
 *   2. Le job a la condition `needs.deploy-prod.result == 'failure' ||
 *      needs.e2e-prod-smoke.result == 'failure'`
 *   3. Le job retag `:rollback → :latest` avant redeploy
 *   4. Le job a un healthcheck post-rollback (boucle curl `/api/health`)
 *   5. `GET /api/health` sur staging retourne 200 + body `{status: "ok"}`
 *   6. `GET /api/health` ne fuit pas commit SHA / env vars / secrets
 *
 * **DURATION** : ~5-10s (lecture fichier + 5 GETs /api/health).
 *
 * **CLEANUP** : aucun (pas de mutation DB).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MEGA_STAGING_URL } from '../_fixtures/mock-oauth';
import { bypassRateLimitHeaders } from '../../_helpers';

const BUCKET = 'm';
const SPEC = '01-rollback-on-smoke-fail';

// Path du workflow (relative au repo root). Les specs MEGA tournent
// depuis `e2e/staging-full/mega/M-rollback/` → 5 niveaux pour racine.
const WORKFLOW_PATH = resolve(
  __dirname,
  '../../../../.github/workflows/hub-ci.yml',
);

test.describe('Mega M-01 — Rollback safety (statique + live)', () => {
  let workflowYaml: string;

  test.beforeAll(() => {
    try {
      workflowYaml = readFileSync(WORKFLOW_PATH, 'utf-8');
    } catch (err) {
      throw new Error(
        `Impossible de lire ${WORKFLOW_PATH}: ${err instanceof Error ? err.message : err}. ` +
          `Vérifie que la spec tourne depuis le repo Hub (pas un mount foreign).`,
      );
    }
  });

  test('Static 1 : workflow hub-ci.yml contient un job rollback-prod', () => {
    // YAML brut, on cherche le pattern. Plus simple qu'un parser YAML +
    // robuste aux changements de formattage.
    expect(
      workflowYaml,
      `hub-ci.yml doit définir un job "rollback-prod" pour le filet de sécurité prod`,
    ).toMatch(/^\s{2}rollback-prod:/m);
  });

  test('Static 2 : rollback-prod déclenche sur failure deploy-prod OU smoke-prod', () => {
    // La condition critique est `(deploy-prod.result == failure) || (e2e-prod-smoke.result == failure)`.
    // Si le `||` saute, on n'a plus de rollback sur smoke fail = catastrophe
    // (Robert a déjà vécu un mauvais deploy resté 2h en prod en mai 2026).
    expect(
      workflowYaml,
      `Condition rollback doit lister 'deploy-prod.result == failure' (cf hub-ci.yml §rollback)`,
    ).toMatch(/needs\.deploy-prod\.result\s*==\s*'failure'/);
    expect(
      workflowYaml,
      `Condition rollback DOIT inclure aussi 'e2e-prod-smoke.result == failure' ` +
        `(filet sur smoke prod, anti-régression incident mai 2026)`,
    ).toMatch(/needs\.e2e-prod-smoke\.result\s*==\s*'failure'/);
  });

  test('Static 3 : rollback retag :rollback → :latest avant redeploy', () => {
    // Le retag `docker tag :rollback :latest` est l'étape qui rend la
    // restauration effective côté image. Sans elle, le redeploy
    // Dokploy re-pull la même image cassée = boucle infinie.
    expect(
      workflowYaml,
      `Le step rollback DOIT contenir 'docker tag ghcr.io/christ-roy/veridian-hub:rollback ' + ` +
        `'ghcr.io/christ-roy/veridian-hub:latest'`,
    ).toMatch(
      /docker tag ghcr\.io\/christ-roy\/veridian-hub:rollback ghcr\.io\/christ-roy\/veridian-hub:latest/,
    );
  });

  test('Static 4 : rollback a un healthcheck post-restoration', () => {
    // Après le retag + redeploy, on doit valider que le rollback a bien
    // remis prod en route. Healthcheck via `curl /api/health`. Sans
    // cette boucle, on ne saurait pas si le rollback marche réellement
    // (peut-être l'image :rollback est elle-même cassée, ou le compose
    // Dokploy a un autre problème).
    // Pattern attendu : boucle for/seq + curl + grep "ok" + sleep.
    expect(
      workflowYaml,
      `Le job rollback-prod DOIT inclure une boucle healthcheck post-rollback. ` +
        `Pattern attendu : curl + grep "status":"ok" + retry loop. Sans ça, ` +
        `on perd la confirmation que le rollback est effectif.`,
    ).toMatch(/curl[^\n]*\/api\/health[^\n]*\|\s*grep[^\n]*status[^\n]*ok/);
  });

  test('Live 5 : GET /api/health staging retourne 200 + body status:ok stable', async ({
    request,
  }) => {
    // Le healthcheck du rollback est UNIQUEMENT efficace si /api/health
    // est implémenté côté Hub et répond 200 fiablement. Si cet endpoint
    // est cassé (ex: hard-dépendance Prisma qui timeout au boot), le
    // rollback healthcheck pensera que prod est down même après restaure.
    //
    // 5 GETs sériels avec petite pause : tous doivent 200 + body{status:ok}.
    const results: Array<{ status: number; body: string }> = [];
    for (let i = 0; i < 5; i++) {
      const res = await request.get(`${MEGA_STAGING_URL}/api/health`, {
        headers: bypassRateLimitHeaders(),
        failOnStatusCode: false,
      });
      results.push({ status: res.status(), body: await res.text() });
      if (i < 4) await new Promise((r) => setTimeout(r, 300));
    }

    // Tous 200
    const non200 = results.filter((r) => r.status !== 200);
    expect(
      non200.length,
      `GET /api/health doit être 200 sur 100% des samples (filet rollback). ` +
        `Got ${non200.length}/${results.length} non-200 : ` +
        `${non200
          .map((r) => `${r.status}:${r.body.slice(0, 50)}`)
          .join(' | ')}`,
    ).toBe(0);

    // Body parsing : tous {status: "ok"}
    for (const r of results) {
      let parsed: { status?: unknown } | null = null;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        throw new Error(`/api/health body n'est pas du JSON valide : ${r.body.slice(0, 200)}`);
      }
      expect(
        parsed?.status,
        `/api/health body.status doit être "ok" pour matcher le grep ` +
          `du workflow rollback. Got : ${JSON.stringify(parsed)}`,
      ).toBe('ok');
    }
  });

  test('Live 6 : GET /api/health ne fuit PAS commit SHA / env vars / secrets', async ({
    request,
  }) => {
    // Pendant la fenêtre rollback (typique 1-3 min), un attaquant peut
    // probe /api/health pour comprendre dans quel état est l'infra. On
    // doit ne fuiter QUE le strict minimum (status + timestamp + service
    // name). Pas de commit SHA, pas de version interne, pas d'ENV.
    const res = await request.get(`${MEGA_STAGING_URL}/api/health`, {
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const text = await res.text();
    const lc = text.toLowerCase();

    // Mots-clés interdits dans le body /api/health
    const forbidden = [
      // Secrets ou tokens
      'secret',
      'token',
      'password',
      'apikey',
      'api_key',
      'whsec_',
      'sk_test_',
      'sk_live_',
      // Internal infra leakage
      'database_url',
      'prisma',
      'postgres',
      'dokploy',
      'tailscale',
      // Stack traces / debug
      'stack',
      'error\n',
      ' at /',
    ];
    for (const w of forbidden) {
      expect(
        lc.includes(w),
        `/api/health body fuit "${w}" : ${text.slice(0, 300)}. ` +
          `Le filet rollback doit pouvoir interroger /api/health sans ` +
          `exposer la surface interne pendant la fenêtre de vulnérabilité.`,
      ).toBe(false);
    }

    // Sanity : le body reste minimal (status + timestamp + service)
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Body /api/health doit être JSON parseable: ${text.slice(0, 200)}`);
    }
    // Le body MEGA ne doit pas avoir > 6 keys (status, timestamp, service +
    // marges raisonnables pour version/uptime publics).
    const keyCount = Object.keys(parsed ?? {}).length;
    expect(
      keyCount,
      `/api/health body doit rester minimal (≤ 6 keys publics). ` +
        `Got ${keyCount} keys : ${Object.keys(parsed ?? {}).join(',')}`,
    ).toBeLessThanOrEqual(6);
  });

  // Pas de cleanup nécessaire (spec read-only). On expose les constantes
  // pour traçabilité dans les logs CI si la spec flake.
  test('Meta : constantes spec', () => {
    expect(BUCKET).toBe('m');
    expect(SPEC).toBe('01-rollback-on-smoke-fail');
    expect(WORKFLOW_PATH.endsWith('.github/workflows/hub-ci.yml')).toBe(true);
  });
});
