/** Les jobs rendent une liste d'administrateurs lisible, et celle de prod est la liste connue du code (VER-263). L'ancienne liste par adresse ne revient pas. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ADMINS_CONNUS, lireAdmins } from '@/lib/admin/liste-admins';
import { code, sourcesApplicatives } from './source';

const liste = (f: string) => readFileSync(f, 'utf8').match(/^PLATFORM_ADMINS=(.*)$/m)?.[1];

describe('administrateurs de plateforme', () => {
  it('prod : la liste connue, exactement', () => expect(lireAdmins(liste('deploy/hub.nomad.hcl'))).toEqual(ADMINS_CONNUS));
  it('l\'administrateur d\'épreuve n\'existe qu\'en staging', () => {
    expect(liste('deploy/hub-staging.nomad.hcl')).toContain('e2e45000-');
    expect(liste('deploy/hub.nomad.hcl')).not.toContain('e2e45000-');
  });
  it('staging : lisible', () => expect(lireAdmins(liste('deploy/hub-staging.nomad.hcl'))).not.toBeNull());
  it('aucun code ne lit d\'adresses d\'administrateurs', () => {
    expect(/ADMIN_EMAILS/.test('process.env.ADMIN_EMAILS')).toBe(true);
    expect(sourcesApplicatives().filter((p) => /ADMIN_EMAILS/.test(code(p)))).toEqual([]);
  });
});
