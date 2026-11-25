import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifierStandardWebhooks } from '@/lib/evenements/signature';

const SECRET = `whsec_${Buffer.from('secret-de-test-32-octets-minimum!').toString('base64')}`;
const NOW = 1_800_000_000_000;
const signer = (id: string, ts: number, corps: string, secret = SECRET) => `v1,${createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${corps}`).digest('base64')}`;
const h = (o: Record<string, string>) => new Headers(o);
const bon = (corps: string, ts = NOW / 1000) => h({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': signer('msg_1', ts, corps) });

describe('verifierStandardWebhooks', () => {
  it('une signature valide passe, dans la fenêtre de 5 min des deux côtés', () => {
    expect(verifierStandardWebhooks(SECRET, bon('{}'), '{}', NOW)).toBe('ok');
    expect(verifierStandardWebhooks(SECRET, bon('{}', NOW / 1000 - 299), '{}', NOW)).toBe('ok');
  });
  it('hors fenêtre : refusé, même bien signé', () => {
    expect(verifierStandardWebhooks(SECRET, bon('{}', NOW / 1000 - 301), '{}', NOW)).toBe('timestamp_expired');
    expect(verifierStandardWebhooks(SECRET, bon('{}', NOW / 1000 + 301), '{}', NOW)).toBe('timestamp_expired');
  });
  it('corps changé, mauvais secret, id changé : refusé', () => {
    expect(verifierStandardWebhooks(SECRET, bon('{}'), '{"a":1}', NOW)).toBe('invalid_signature');
    expect(verifierStandardWebhooks(`whsec_${Buffer.from('autre-secret-de-test-32-octets!!').toString('base64')}`, bon('{}'), '{}', NOW)).toBe('invalid_signature');
    const x = bon('{}');
    x.set('webhook-id', 'msg_2');
    expect(verifierStandardWebhooks(SECRET, x, '{}', NOW)).toBe('invalid_signature');
  });
  it('en-têtes absents ou mal formés : invalid_headers', () => {
    expect(verifierStandardWebhooks(SECRET, h({}), '{}', NOW)).toBe('invalid_headers');
    expect(verifierStandardWebhooks(SECRET, h({ 'webhook-id': 'a', 'webhook-timestamp': 'x', 'webhook-signature': 'v1,AA' }), '{}', NOW)).toBe('invalid_headers');
  });
  it('plusieurs signatures (rotation) : une bonne suffit ; v2 et longueur fausse ne passent pas', () => {
    const x = bon('{}');
    x.set('webhook-signature', `v1,AAAA ${x.get('webhook-signature')}`);
    expect(verifierStandardWebhooks(SECRET, x, '{}', NOW)).toBe('ok');
    x.set('webhook-signature', signer('msg_1', NOW / 1000, '{}').replace('v1,', 'v2,'));
    expect(verifierStandardWebhooks(SECRET, x, '{}', NOW)).toBe('invalid_signature');
  });
});
