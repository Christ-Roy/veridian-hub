import { describe, expect, it } from 'vitest';

import { chiffrer, CoffreIndisponible, dechiffrer, empreinteCle, finDeCle, masquer } from '@/lib/ia/coffre';

const env = { VAULT_ENC_KEY: 'k'.repeat(43) } as NodeJS.ProcessEnv;
const autre = { VAULT_ENC_KEY: 'z'.repeat(43) } as NodeJS.ProcessEnv;
const CLE = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef';

describe('coffre des clés d\'IA', () => {
  it('chiffre puis déchiffre ; le scellé ne contient pas la clé', () => {
    const s = chiffrer(CLE, env);
    expect(s.startsWith('v1.')).toBe(true);
    expect(s).not.toContain(CLE);
    expect(s).not.toContain(CLE.slice(10, 30));
    expect(dechiffrer(s, env)).toBe(CLE);
  });

  it('deux chiffrements de la même clé diffèrent (IV aléatoire)', () => {
    expect(chiffrer(CLE, env)).not.toBe(chiffrer(CLE, env));
  });

  it('une autre VAULT_ENC_KEY ne déchiffre pas, un scellé altéré est refusé', () => {
    const s = chiffrer(CLE, env);
    expect(() => dechiffrer(s, autre)).toThrow();
    const parts = s.split('.');
    parts[3] = Buffer.from('altere').toString('base64url');
    expect(() => dechiffrer(parts.join('.'), env)).toThrow();
  });

  it('sans VAULT_ENC_KEY : coffre indisponible, jamais un chiffrement faible', () => {
    expect(() => chiffrer(CLE, {} as NodeJS.ProcessEnv)).toThrow(CoffreIndisponible);
    expect(() => chiffrer(CLE, { VAULT_ENC_KEY: 'court' } as NodeJS.ProcessEnv)).toThrow(CoffreIndisponible);
  });

  it('seuls les 4 derniers caractères s\'affichent, l\'empreinte ne contient pas la clé', () => {
    expect(finDeCle(CLE)).toBe('cdef');
    expect(empreinteCle(CLE)).toMatch(/^[0-9a-f]{64}$/);
    expect(empreinteCle(CLE)).not.toContain(CLE.slice(0, 12));
  });
});

describe('masquer : fuite provoquée', () => {
  it('une erreur du fournisseur qui cite la clé ressort sans elle', () => {
    const erreur = `401 Unauthorized: invalid x-api-key ${CLE} for org`;
    expect(masquer(erreur, [CLE])).not.toContain(CLE);
  });

  it('une trace du SDK qui recopie les en-têtes ressort sans la clé, même non déclarée', () => {
    const trace = JSON.stringify({ headers: { 'x-api-key': CLE, authorization: `Bearer sk-or-v1-${'q'.repeat(40)}` } });
    const sortie = masquer(trace);
    expect(sortie).not.toContain(CLE);
    expect(sortie).not.toContain('q'.repeat(40));
    expect(sortie).toContain('[clé masquée]');
  });

  it('une clé à forme inconnue mais déclarée est masquée', () => {
    const k = 'mistral-ZZZZYYYYXXXXWWWW1234';
    expect(masquer(`échec avec ${k}`, [k])).toBe('échec avec [clé masquée]');
  });
});
