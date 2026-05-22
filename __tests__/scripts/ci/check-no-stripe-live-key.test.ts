/**
 * Tests pour scripts/ci/check-no-stripe-live-key.sh
 *
 * Garde-fou pre-push : refuse tout fichier tracké contenant une clé Stripe
 * LIVE en clair (sk_live_ / rk_live_ / pk_live_ + >=20 chars alphanum).
 *
 * Couvre :
 *  - repo propre → exit 0
 *  - vraie clé live longue committée → exit 1
 *  - faux positifs (commentaire, préfixe nu, fausse clé courte) → exit 0
 *  - fichier non tracké contenant une clé → ignoré (le hook scanne git ls-files)
 *
 * Le script fait `git ls-files`, donc chaque cas tourne dans un dépôt git
 * temporaire isolé où l'on contrôle exactement les fichiers trackés.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT_SRC = path.resolve(__dirname, '../../../scripts/ci/check-no-stripe-live-key.sh');

/**
 * Construit un dépôt git jetable : copie le script à l'emplacement attendu
 * (scripts/ci/), écrit les fichiers fournis, git add tout, et renvoie la
 * racine. Le script résout APP_ROOT via son propre chemin, donc il doit
 * vivre sous <root>/scripts/ci/.
 */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stripe-leak-'));
  mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  const scriptDst = path.join(root, 'scripts', 'ci', 'check-no-stripe-live-key.sh');
  copyFileSync(SCRIPT_SRC, scriptDst);

  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });

  for (const [rel, content] of Object.entries(files)) {
    const dst = path.join(root, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

/** Lance le script dans le repo, renvoie le code de sortie (0 = safe). */
function runCheck(root: string): number {
  try {
    execFileSync('bash', ['scripts/ci/check-no-stripe-live-key.sh'], {
      cwd: root,
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

// Fausses clés live au bon format (préfixe + 48 chars alphanum) — assez
// longues pour franchir le seuil de 20, jamais de vraies clés Stripe.
//
// ⚠️ Construites par concaténation à l'exécution, JAMAIS écrites en littéral :
// un littéral `sk_live_<~99 chars>` déclencherait le secret-scanning GitHub
// (push protection) — le scanner ne distingue pas une fixture d'une vraie clé.
// La concat sépare le préfixe du corps → aucun motif complet dans le source.
const FAKE_BODY = 'AbcdEfghIjklMnopQrstUvwxYz0123456789ABCDEFGHIJKL';
const fakeKey = (prefix: 'sk' | 'pk' | 'rk'): string =>
  `${prefix}_` + 'live_' + FAKE_BODY;
const FAKE_LIVE = fakeKey('sk');

describe('check-no-stripe-live-key.sh', () => {
  const repos: string[] = [];
  function track(root: string): string {
    repos.push(root);
    return root;
  }

  afterAll(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  it('exit 0 sur un repo sans clé live', () => {
    const root = track(makeRepo({
      'app/code.ts': 'const x = process.env.STRIPE_SECRET_KEY_LIVE;\n',
    }));
    expect(runCheck(root)).toBe(0);
  });

  it('exit 1 quand une vraie clé live longue est committée', () => {
    const root = track(makeRepo({
      'app/leak.ts': `const k = "${FAKE_LIVE}";\n`,
    }));
    expect(runCheck(root)).toBe(1);
  });

  it('exit 0 sur les faux positifs légitimes (commentaire, préfixe nu, fausse clé courte)', () => {
    const root = track(makeRepo({
      '.env.example': '# Prod : sk_live_... / Staging : sk_test_...\n',
      'scripts/setup.ts': "const expectedPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_';\n",
      '__tests__/env.test.ts': "process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_456';\n",
    }));
    expect(runCheck(root)).toBe(0);
  });

  it('ignore un fichier NON tracké contenant une clé (scan = git ls-files)', () => {
    const root = track(makeRepo({
      'app/code.ts': 'const x = 1;\n',
    }));
    // Écrit un fichier avec une clé live MAIS sans git add → non tracké.
    writeFileSync(path.join(root, 'untracked-leak.ts'), `const k = "${FAKE_LIVE}";\n`);
    expect(runCheck(root)).toBe(0);
  });

  it('détecte aussi pk_live_ et rk_live_', () => {
    const rootPk = track(makeRepo({
      'app/pub.ts': `const p = "${fakeKey('pk')}";\n`,
    }));
    expect(runCheck(rootPk)).toBe(1);

    const rootRk = track(makeRepo({
      'app/restricted.ts': `const r = "${fakeKey('rk')}";\n`,
    }));
    expect(runCheck(rootRk)).toBe(1);
  });
});
