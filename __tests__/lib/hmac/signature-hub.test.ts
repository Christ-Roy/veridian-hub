import { createHash, createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { appsEnV2, entetesSignature } from '@/lib/hmac/signature-hub';

const SECRET = 'secret-de-test';
const TS = 1_700_000_000_000;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('entetesSignature, v1 (HMAC_V2_APPS absente ou vide)', () => {
  it('reste octet pour octet la signature d\'avant : hex(HMAC(secret, ts.corps))', () => {
    const corps = '{"a":1}';
    const h = entetesSignature({ secret: SECRET, methode: 'POST', url: 'https://x.test/api/p?z=1', corps, app: 'notifuse', maintenant: TS });
    expect(h).toEqual({
      'X-Veridian-Timestamp': String(TS),
      'X-Veridian-Hub-Signature': createHmac('sha256', SECRET).update(`${TS}.${corps}`).digest('hex'),
    });
    expect(h['X-Veridian-Sig-Version']).toBeUndefined();
  });

  it('un GET sans corps signe `ts.`', () => {
    const h = entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app: 'crm', maintenant: TS });
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', SECRET).update(`${TS}.`).digest('hex'));
  });

  it('variable vide : v1 aussi', () => {
    vi.stubEnv('HMAC_V2_APPS', '');
    const h = entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app: 'notifuse', maintenant: TS });
    expect(h['X-Veridian-Sig-Version']).toBeUndefined();
  });
});

describe('entetesSignature, v2 (HMAC_V2_APPS=notifuse)', () => {
  it('signe ts, méthode, chemin, query brute et sha256 du corps, séparés par des retours à la ligne', () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const corps = '{"reason":"x"}';
    const h = entetesSignature({ secret: SECRET, methode: 'POST', url: 'https://x.test/api/t%20a/purge?b=2&a=%C3%A9', corps, app: 'notifuse', maintenant: TS });
    const attendu = createHmac('sha256', SECRET)
      .update(`${TS}\nPOST\n/api/t%20a/purge\nb=2&a=%C3%A9\n${hex(corps)}`)
      .digest('hex');
    expect(h['X-Veridian-Hub-Signature']).toBe(attendu);
    expect(h['X-Veridian-Sig-Version']).toBe('2');
    expect(h['X-Veridian-Timestamp']).toBe(String(TS));
  });

  it('corps vide : sha256 de la chaîne vide, query vide', () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const h = entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/api/users', corps: null, app: 'notifuse', maintenant: TS });
    const attendu = createHmac('sha256', SECRET).update(`${TS}\nGET\n/api/users\n\n${hex('')}`).digest('hex');
    expect(h['X-Veridian-Hub-Signature']).toBe(attendu);
  });

  it('la méthode est mise en majuscules', () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const a = entetesSignature({ secret: SECRET, methode: 'delete', url: 'https://x.test/a', app: 'notifuse', maintenant: TS });
    const b = entetesSignature({ secret: SECRET, methode: 'DELETE', url: 'https://x.test/a', app: 'notifuse', maintenant: TS });
    expect(a['X-Veridian-Hub-Signature']).toBe(b['X-Veridian-Hub-Signature']);
  });

  it('la méthode, le chemin, la query et le corps changent la signature', () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const base = { secret: SECRET, methode: 'GET', url: 'https://x.test/a?q=1', corps: '', app: 'notifuse', maintenant: TS };
    const s = (o: Partial<typeof base>) => entetesSignature({ ...base, ...o })['X-Veridian-Hub-Signature'];
    const ref = s({});
    expect(s({ methode: 'DELETE' })).not.toBe(ref);
    expect(s({ url: 'https://x.test/b?q=1' })).not.toBe(ref);
    expect(s({ url: 'https://x.test/a?q=2' })).not.toBe(ref);
    expect(s({ corps: '{}' })).not.toBe(ref);
  });

  it('deux appels successifs prennent un timestamp neuf, donc une signature différente', () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    vi.useFakeTimers();
    vi.setSystemTime(TS);
    const a = entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app: 'notifuse' });
    vi.setSystemTime(TS + 5);
    const b = entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app: 'notifuse' });
    expect(a['X-Veridian-Timestamp']).not.toBe(b['X-Veridian-Timestamp']);
    expect(a['X-Veridian-Hub-Signature']).not.toBe(b['X-Veridian-Hub-Signature']);
  });
});

describe('interrupteur HMAC_V2_APPS', () => {
  it('n\'allume la v2 que pour l\'app nommée', () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const v = (app: string) => entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app, maintenant: TS })['X-Veridian-Sig-Version'];
    expect(v('notifuse')).toBe('2');
    for (const autre of ['prospection', 'crm', 'analytics', 'academy', 'cms']) expect(v(autre)).toBeUndefined();
  });

  it('liste à virgules, espaces et casse tolérés ; twenty vaut crm', () => {
    vi.stubEnv('HMAC_V2_APPS', ' Notifuse , twenty ,');
    expect([...appsEnV2()].sort()).toEqual(['crm', 'notifuse']);
    const h = entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app: 'crm', maintenant: TS });
    expect(h['X-Veridian-Sig-Version']).toBe('2');
  });

  it('est relue à chaque appel, sans constante figée au chargement', () => {
    const f = () => entetesSignature({ secret: SECRET, methode: 'GET', url: 'https://x.test/a', app: 'notifuse', maintenant: TS })['X-Veridian-Sig-Version'];
    vi.stubEnv('HMAC_V2_APPS', '');
    expect(f()).toBeUndefined();
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    expect(f()).toBe('2');
  });
});
