/**
 * Deux versions servies pendant un canari (count=2, VER-270) : sans `deploymentId`, une server action qui vise l'autre version fige la page
 * (mesuré chez Academy, 27/11). Le commit construit doit arriver à la construction de Next, pas seulement à l'image qui tourne.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const CONSTRUIRE = ['RUN pnpm run', 'build'].join(' ');

describe('deploymentId de Next = le commit construit', () => {
  it('next.config le lit de HUB_DEPLOYMENT_ID', () => {
    expect(lire('next.config.js')).toMatch(/deploymentId:\s*process\.env\.HUB_DEPLOYMENT_ID/);
  });
  it('le Dockerfile pose HUB_DEPLOYMENT_ID depuis GIT_SHA AVANT la construction, dans la même étape', () => {
    const d = lire('Dockerfile');
    const fin = d.indexOf(CONSTRUIRE);
    const avant = d.slice(d.lastIndexOf('\nFROM ', fin), fin);
    expect([fin > 0, /ARG GIT_SHA/.test(avant), /ENV HUB_DEPLOYMENT_ID=\$GIT_SHA/.test(avant)]).toEqual([true, true, true]);
  });
  it('la CI passe bien GIT_SHA à la construction de l\'image', () => {
    expect(lire('.github/workflows/hub-ci.yml')).toMatch(/build-args:\s*GIT_SHA=\$\{\{ github\.sha \}\}/);
  });
});
