/** /api/vivant : le processus répond, sans jamais toucher la base (sonde du healthcheck Traefik, VER-270). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const requete = vi.hoisted(() => vi.fn());
vi.mock('@/lib/prisma', () => ({ prisma: new Proxy({}, { get: () => requete }) }));

import { GET } from '@/app/api/vivant/route';

describe('GET /api/vivant', () => {
  it('200 { status: ok }, sans cache, sans un seul appel à la base', async () => {
    const r = GET();
    expect([r.status, await r.json(), r.headers.get('cache-control')]).toEqual([200, { status: 'ok' }, 'no-store']);
    expect(requete).not.toHaveBeenCalled();
  });
  it('la route n\'importe rien qui lise la base ou la session', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/vivant/route.ts'), 'utf8');
    expect(source.match(/from '([^']+)'/g)).toEqual(["from 'next/server'"]);
  });
});
