/**
 * Décision A : chaque tenant ouvert a son atelier ; le Hub n'envoie jamais un tenant vers l'atelier d'un autre,
 * et il n'y a plus d'atelier commun (D2, 23/11) : un tenant sans atelier propre n'en a aucun.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adresseAtelierDuTenant, atelierConfigure, suffixeAtelier, vientDeLAtelier } from '@/lib/ia/atelier';

const dir = mkdtempSync(path.join(tmpdir(), 'ateliers-'));
const fichier = path.join(dir, 'ateliers');
writeFileSync(fichier, 'hub-atelier-8fa7e09d http://100.96.29.49:24001\nhub-atelier-359b76d5 http://100.96.29.49:24002\n');
const SECRET = 's'.repeat(40);
const env = { ATELIER_PAR_TENANT_FICHIER: fichier, ATELIER_SECRET: SECRET } as NodeJS.ProcessEnv;
const TEST = '8fa7e09d-e620-422c-bbc4-76fd66cf46e8';
const ROBERT = '359b76d5-bab7-4773-a889-cf4cf0248869';
const AUTRE = 'aaaaaaaa-0000-4000-8000-000000000000';

describe('routage vers l\'atelier du tenant', () => {
  it('suffixe : 8 premiers caractères hexadécimaux, en minuscules', () => {
    expect(suffixeAtelier('8FA7E09D-e620-422c-bbc4-76fd66cf46e8')).toBe('8fa7e09d');
  });

  it('chaque tenant ouvert va à SON atelier', () => {
    expect(adresseAtelierDuTenant(TEST, env)).toBe('http://100.96.29.49:24001');
    expect(adresseAtelierDuTenant(ROBERT, env)).toBe('http://100.96.29.49:24002');
  });

  it('un tenant sans atelier propre : aucun atelier, jamais celui d\'un autre ni un atelier commun', () => {
    expect(adresseAtelierDuTenant(AUTRE, { ...env, ATELIER_URL: 'http://commun:1' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(atelierConfigure(AUTRE, env)).toBe(false);
  });

  it('fichier des ateliers absent ou pas encore rendu : aucun atelier', () => {
    expect(adresseAtelierDuTenant(TEST, { ATELIER_SECRET: SECRET } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(adresseAtelierDuTenant(TEST, { ...env, ATELIER_PAR_TENANT_FICHIER: path.join(dir, 'absent') } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('configuré : seulement pour un tenant qui a son atelier, et jamais sans tenant', () => {
    expect(atelierConfigure(TEST, env)).toBe(true);
    expect(atelierConfigure(null, env)).toBe(false);
    expect(atelierConfigure(TEST, { ...env, ATELIER_SECRET: 'court' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('signature des appels de l\'atelier', () => {
  const NOW = 1_795_400_000_000;
  const signer = (corps: string, secret = SECRET, ts = String(NOW)) =>
    new Headers({ 'x-veridian-timestamp': ts, 'x-veridian-atelier-signature': createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex') });

  it('ne dépend que du secret : valide sans aucune adresse d\'atelier (les outils marchent après D2)', () => {
    expect(vientDeLAtelier(signer('{}'), '{}', { ATELIER_SECRET: SECRET } as NodeJS.ProcessEnv, NOW)).toBe(true);
  });

  it('refusée : autre secret, corps changé, horodatage vieux, secret absent', () => {
    const e = { ATELIER_SECRET: SECRET } as NodeJS.ProcessEnv;
    expect(vientDeLAtelier(signer('{}', 'z'.repeat(40)), '{}', e, NOW)).toBe(false);
    expect(vientDeLAtelier(signer('{}'), '{"x":1}', e, NOW)).toBe(false);
    expect(vientDeLAtelier(signer('{}', SECRET, String(NOW - 6 * 60_000)), '{}', e, NOW)).toBe(false);
    expect(vientDeLAtelier(signer('{}'), '{}', {} as NodeJS.ProcessEnv, NOW)).toBe(false);
  });
});
