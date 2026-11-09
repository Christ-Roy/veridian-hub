import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { appSignataire } from '@/lib/mcp/connexions-apps';

const env = {
  PROSPECTION_API_URL: 'https://p.test',
  PROSPECTION_HUB_API_SECRET: 'secret-p',
  ANALYTICS_API_URL: 'https://a.test',
  ANALYTICS_HUB_API_SECRET: 'secret-a',
} as NodeJS.ProcessEnv;
const MAINTENANT = 1_800_000_000_000;
const signe = (secret: string, ts = String(MAINTENANT)) =>
  new Headers({ 'x-veridian-timestamp': ts, 'x-veridian-hub-signature': createHmac('sha256', secret).update(`${ts}.`).digest('hex') });

describe('connexions IA lues par une app (HMAC §6.1)', () => {
  it('reconnaît l\'app qui a signé', () => {
    expect(appSignataire(signe('secret-a'), env, MAINTENANT)).toBe('analytics');
    expect(appSignataire(signe('secret-p'), env, MAINTENANT)).toBe('prospection');
  });
  it('refuse un secret inconnu, un horodatage hors fenêtre, des en-têtes absents', () => {
    expect(appSignataire(signe('autre'), env, MAINTENANT)).toBeNull();
    expect(appSignataire(signe('secret-a', String(MAINTENANT - 10 * 60_000)), env, MAINTENANT)).toBeNull();
    expect(appSignataire(new Headers(), env, MAINTENANT)).toBeNull();
  });
});
