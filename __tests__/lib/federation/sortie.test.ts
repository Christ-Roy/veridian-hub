// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ liste: [] as { address: string; family: number }[] }));
vi.mock('node:dns', () => ({ lookup: (_h: string, _o: unknown, cb: (e: null, l: unknown) => void) => cb(null, m.liste) }));

import { adressePublique, fetchGarde, resoudrePublique } from '@/lib/federation/sortie';

it('adressePublique : ni nos réseaux, ni la machine, ni une IPv4 cachée dans une IPv6', () => {
  expect(['8.8.8.8', '2a00:1450:4007::1'].map(adressePublique)).toEqual([true, true]);
  const non = ['10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '2002:a00:1::', '64:ff9b::a00:1', 'nom'];
  expect(non.filter(adressePublique)).toEqual([]);
});

describe('resoudrePublique', () => {
  const res = (all: boolean) => new Promise<unknown[]>((ok) => resoudrePublique('idp.client.test', { all } as never, ((...a: unknown[]) => ok(a)) as never));
  it('un nom public qui désigne nos réseaux, même une fois sur deux : refusé', async () => {
    for (const l of [['10.0.0.1'], ['8.8.8.8', '100.64.1.2'], []]) {
      m.liste = l.map((address) => ({ address, family: 4 }));
      expect(String(((await res(true)) as [Error])[0])).toContain('adresse_privee');
    }
  });
  it('un nom public : son adresse', async () => {
    m.liste = [{ address: '8.8.8.8', family: 4 }];
    expect(await res(false)).toEqual([null, '8.8.8.8', 4]);
    expect(await res(true)).toEqual([null, m.liste]);
  });
});

it('fetchGarde : en clair, ou vers nos réseaux, rien ne part', async () => {
  m.liste = [{ address: '10.0.0.1', family: 4 }];
  for (const u of ['http://idp.client.test/', 'https://10.0.0.1/', 'https://0x0a000001/', 'https://[::1]:9/', 'https://[fd00::1]:9/', 'https://[::ffff:10.0.0.1]:9/', 'https://idp.client.test/']) await expect(fetchGarde(u)).rejects.toThrow('adresse_privee');
});
