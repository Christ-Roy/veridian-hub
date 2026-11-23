/**
 * Deux classes fermées le 23/11 : un mot de passe ne se vérifie que sous le plafond par compte, et l'IP de l'appelant ne
 * se lit qu'à un endroit. `mfa/start` vérifiait le mot de passe sans plafond par compte, et la clé des limiteurs venait
 * d'un en-tête que l'appelant écrit.
 */
import { describe, expect, it } from 'vitest';

import { code, parcourir } from './source';

const fichiers = [...parcourir('app'), ...parcourir('lib'), 'auth.ts', 'auth.config.ts', 'middleware.ts'].filter((f) => /\.tsx?$/.test(f));
const contenant = (motif: RegExp) => fichiers.filter((f) => motif.test(code(f))).sort();

describe('connexion', () => {
  it('bcrypt.compare : le plafond par compte, les codes MFA (5 par 10 min), « même mot de passe » d\'un compte connecté', () => {
    expect(contenant(/bcrypt\s*\.\s*compare\s*\(/)).toEqual(['app/api/account/password/route.ts', 'lib/auth/plafond-compte.ts', 'lib/mfa/index.ts']);
  });

  it('les deux portes du mot de passe passent par verifierMotDePasse', () => {
    expect(contenant(/verifierMotDePasse\(\{/)).toEqual(['app/api/auth/mfa/start/route.ts', 'auth.ts']);
  });

  it('les en-têtes d\'adresse ne se lisent que dans lib/auth/ip-client.ts', () => {
    expect(contenant(/\.get\(\s*['"](x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip)['"]/i)).toEqual(['lib/auth/ip-client.ts']);
  });
});
