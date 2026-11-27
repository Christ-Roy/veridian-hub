// @vitest-environment node
/**
 * Contrat : une épreuve qui crée un dépôt git jetable ne touche jamais le dépôt qui la lance.
 * Lancé d'un hook git, GIT_DIR pointe le vrai dépôt : sans `unset` en tête, `git config user.email t@t`
 * s'y écrit. Ici le « vrai dépôt » est un témoin jetable, et sa configuration ne doit pas bouger.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const SELFTEST = path.resolve(__dirname, '../../../scripts/ci/check-no-secrets.selftest.sh');
const jetables: string[] = [];

const sansGit = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  return e;
};

const temoin = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'temoin-git-'));
  jetables.push(d);
  execFileSync('git', ['init', '-q', d], { env: sansGit() });
  return d;
};

const config = (d: string): string => execFileSync('git', ['config', '--local', '--list'], { cwd: d, env: sansGit() }).toString();

afterAll(() => jetables.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('check-no-secrets.selftest.sh sous variables GIT_*', () => {
  it('ne modifie pas la configuration du dépôt désigné par GIT_DIR', () => {
    const d = temoin();
    const avant = config(d);
    const sortie = execFileSync('bash', [SELFTEST], {
      env: { ...sansGit(), GIT_DIR: path.join(d, '.git'), GIT_WORK_TREE: d },
      stdio: 'pipe',
    }).toString();
    expect(sortie, "le selftest doit avoir tourné jusqu'au bout").toMatch(/✓/);
    expect(config(d), 'configuration du témoin').toBe(avant);
    expect(config(d)).not.toContain('t@t');
  }, 120_000);
});
