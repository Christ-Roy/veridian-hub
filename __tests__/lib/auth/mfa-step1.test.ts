/**
 * D3 : cookie signé « étape 1 réussie » (mot de passe vérifié, code envoyé). Il lie la
 * vérification du code à l'utilisateur et au navigateur qui a passé le mot de passe.
 */
import { describe, it, expect } from 'vitest';
import {
  MFA_STEP1_TTL_S,
  signerEtapeUn,
  verifierEtapeUn,
} from '@/lib/auth/mfa-step1';

const SECRET = 'secret-de-test-au-moins-32-octets-xxxxxxxx';
const NOW = 1_800_000_000;

describe('cookie d\'étape 1 MFA (D3)', () => {
  it('un cookie frais renvoie l\'utilisateur', () => {
    const v = signerEtapeUn('user-42', NOW, SECRET);
    expect(verifierEtapeUn(v, SECRET, NOW + 10)).toBe('user-42');
  });

  it('expire après la durée prévue', () => {
    const v = signerEtapeUn('user-42', NOW, SECRET);
    expect(verifierEtapeUn(v, SECRET, NOW + MFA_STEP1_TTL_S + 1)).toBeNull();
  });

  it('un uid modifié invalide la signature', () => {
    const v = signerEtapeUn('user-42', NOW, SECRET);
    const [, exp, sig] = v.split('.');
    const forge = Buffer.from('autre-user').toString('base64url');
    expect(verifierEtapeUn(`${forge}.${exp}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('un autre secret ne vérifie pas', () => {
    const v = signerEtapeUn('user-42', NOW, SECRET);
    expect(verifierEtapeUn(v, 'autre-secret-au-moins-32-octets-yyyyyyyy', NOW)).toBeNull();
  });

  it('une valeur malformée ou absente ne vérifie rien', () => {
    expect(verifierEtapeUn(undefined, SECRET, NOW)).toBeNull();
    expect(verifierEtapeUn('n-importe-quoi', SECRET, NOW)).toBeNull();
    expect(verifierEtapeUn('a.b.c.d', SECRET, NOW)).toBeNull();
  });
});
