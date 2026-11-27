/**
 * Contrat : le Hub n'ouvre Mail (Notifuse) que par le rebond signé (`lienApp('notifuse')`, puis
 * `issueMagicLinkForApp`). L'ancienne ouverture (`workspaces.generateMagicLink`, `auto_login_url`)
 * ne doit plus réapparaître dans le code du Hub.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sansCommentaires } from './source';

const INTERDIT = /generateMagicLink|auto_login_url/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((nom) => {
    if (nom === 'node_modules' || nom === '.next') return [];
    const chemin = join(dir, nom);
    return statSync(chemin).isDirectory() ? walk(chemin) : [chemin];
  });
}

const fichiers = ['app', 'lib', 'components', 'utils']
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(walk)
  .filter((p) => /\.(ts|tsx)$/.test(p));

describe("Mail ne s'ouvre que par le rebond", () => {
  it('la mesure voit du code (elle ne tourne pas à vide)', () => {
    expect(fichiers).toContain('lib/apps/lien-app.ts');
    expect(INTERDIT.test('workspaces.generateMagicLink')).toBe(true);
    expect(INTERDIT.test('x.auto_login_url')).toBe(true);
  });

  it("aucune trace de l'ancienne ouverture dans app, lib, components, utils", () => {
    const fautifs = fichiers.filter((p) => INTERDIT.test(sansCommentaires(readFileSync(p, 'utf8'))));
    expect(fautifs).toEqual([]);
  });

  it('le bouton Mail passe par le rebond', () => {
    expect(readFileSync('app/api/admin/notifuse/magic-link/route.ts', 'utf8')).toMatch(/lienApp\('notifuse'\)/);
  });
});
