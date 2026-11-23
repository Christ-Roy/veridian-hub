/** Décision A : chaque tenant ouvert a son atelier ; le Hub n'envoie jamais un tenant vers l'atelier d'un autre. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adresseAtelierDuTenant, suffixeAtelier } from '@/lib/ia/atelier';

const dir = mkdtempSync(path.join(tmpdir(), 'ateliers-'));
const fichier = path.join(dir, 'ateliers');
const commun = path.join(dir, 'atelier-url');
writeFileSync(fichier, 'hub-atelier-8fa7e09d http://100.96.29.49:24001\nhub-atelier-359b76d5 http://100.96.29.49:24002\n');
writeFileSync(commun, 'http://100.96.29.49:21346\n');
const env = { ATELIER_PAR_TENANT_FICHIER: fichier, ATELIER_URL_FICHIER: commun } as NodeJS.ProcessEnv;

describe('routage vers l\'atelier du tenant', () => {
  it('suffixe : 8 premiers caractères hexadécimaux, en minuscules', () => {
    expect(suffixeAtelier('8FA7E09D-e620-422c-bbc4-76fd66cf46e8')).toBe('8fa7e09d');
  });

  it('chaque tenant ouvert va à SON atelier', () => {
    expect(adresseAtelierDuTenant('8fa7e09d-e620-422c-bbc4-76fd66cf46e8', env)).toBe('http://100.96.29.49:24001');
    expect(adresseAtelierDuTenant('359b76d5-bab7-4773-a889-cf4cf0248869', env)).toBe('http://100.96.29.49:24002');
  });

  it('un tenant sans atelier propre : l\'atelier commun, jamais celui d\'un autre tenant', () => {
    expect(adresseAtelierDuTenant('aaaaaaaa-0000-4000-8000-000000000000', env)).toBe('http://100.96.29.49:21346');
  });

  it('fichier des ateliers absent : repli sur l\'atelier commun', () => {
    expect(adresseAtelierDuTenant('8fa7e09d-e620-422c-bbc4-76fd66cf46e8', { ATELIER_URL_FICHIER: commun } as NodeJS.ProcessEnv)).toBe('http://100.96.29.49:21346');
  });
});
