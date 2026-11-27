/** Aide des tests de migration vers `lib/hmac/signature-hub.ts` : la signature v2 attendue, recalculée indépendamment du module. */
import { createHash, createHmac } from 'node:crypto';

import { expect } from 'vitest';

export const v2Attendue = (secret: string, ts: string, methode: string, url: string, corps = ''): string => {
  const u = new URL(url);
  const canon = [ts, methode.toUpperCase(), u.pathname, u.search.replace(/^\?/, ''), createHash('sha256').update(corps).digest('hex')].join('\n');
  return createHmac('sha256', secret).update(canon).digest('hex');
};

/** L'appel est parti en v2, signé sur méthode + chemin + query + corps. */
export function exigeV2(h: Record<string, string>, secret: string, methode: string, url: string, corps = ''): void {
  expect(h['X-Veridian-Sig-Version']).toBe('2');
  expect(h['X-Veridian-Hub-Signature']).toBe(v2Attendue(secret, h['X-Veridian-Timestamp'], methode, url, corps));
}

/** L'appel est parti en v1 : `ts.corps`, sans en-tête de version. */
export function exigeV1(h: Record<string, string>, secret: string, corps = ''): void {
  expect(h['X-Veridian-Sig-Version']).toBeUndefined();
  expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', secret).update(`${h['X-Veridian-Timestamp']}.${corps}`).digest('hex'));
}
