/**
 * Test invariant CI — OAUTH_TEST_PROVIDER ne doit JAMAIS apparaître dans
 * compose/prod.yml ou compose/base.yml.
 *
 * Si quelqu'un (ou Claude) déplace le flag par erreur dans le mauvais
 * fichier, ce test rouge bloque la CI avant le deploy prod.
 *
 * Pendant du pre-push hook `scripts/ci/check-no-test-provider-in-prod.sh` :
 * la double protection couvre 2 angles d'attaque :
 *   - Push local sans pre-push (rare mais possible si quelqu'un installe
 *     git hooks différemment) → ce test attrape
 *   - Push avec pre-push mais via auto-promotion staging→main → ce test
 *     attrape aussi
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function readCompose(name: string): string | null {
  const p = path.join(process.cwd(), 'compose', name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

describe('Invariant CI — OAUTH_TEST_PROVIDER en prod = auth bypass critique', () => {
  it('compose/prod.yml ne contient PAS OAUTH_TEST_PROVIDER', () => {
    const content = readCompose('prod.yml');
    if (content === null) {
      // Si le fichier n'existe pas, le test passe (rien à vérifier)
      return;
    }
    expect(
      content,
      'compose/prod.yml contient OAUTH_TEST_PROVIDER — auth bypass en prod',
    ).not.toMatch(/OAUTH_TEST_PROVIDER/);
  });

  it('compose/base.yml ne contient PAS OAUTH_TEST_PROVIDER (sinon fuit dans tous les overrides)', () => {
    const content = readCompose('base.yml');
    if (content === null) return;
    expect(
      content,
      'compose/base.yml contient OAUTH_TEST_PROVIDER — fuit en prod via héritage',
    ).not.toMatch(/OAUTH_TEST_PROVIDER/);
  });

  it('compose/staging.yml a bien OAUTH_TEST_PROVIDER="true" (sinon E2E OAuth cassent)', () => {
    const content = readCompose('staging.yml');
    expect(content).not.toBeNull();
    expect(
      content!,
      'compose/staging.yml doit activer le mock OAuth provider pour les E2E',
    ).toMatch(/OAUTH_TEST_PROVIDER:\s*"true"/);
  });
});
