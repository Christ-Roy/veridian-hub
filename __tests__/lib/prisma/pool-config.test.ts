/**
 * Pendant une bascule de pg-saas, l'entrée accepte le TCP sans qu'aucun primaire réponde. Un socket
 * muet reproduit ce cas : avec les bornes du Hub, la connexion et la requête échouent vite ; sans
 * elles, pg attend sans fin (le test le prouve en sens inverse).
 */
import { createServer, type Server, type Socket } from 'node:net';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BORNES, poolConfig } from '@/lib/prisma/pool-config';

let muet: Server;
let url = '';
const sockets: Socket[] = [];

beforeAll(async () => {
  // Accepte la connexion, ne répond jamais : l'entrée HAProxy sans primaire.
  muet = createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
  });
  await new Promise<void>((r) => muet.listen(0, '127.0.0.1', r));
  const port = (muet.address() as { port: number }).port;
  url = `postgresql://hub:x@127.0.0.1:${port}/hub`;
});

afterAll(async () => {
  sockets.forEach((s) => s.destroy());
  await new Promise<void>((r) => muet.close(() => r()));
});

describe('pool pg du Hub', () => {
  it('bornes de prod : connexion 10 s, requête 60 s, keepalive, durée de vie', () => {
    expect(poolConfig('postgresql://x')).toMatchObject({
      connectionTimeoutMillis: 10_000,
      query_timeout: 60_000,
      keepAlive: true,
      maxLifetimeSeconds: 300,
    });
    expect(BORNES.connectTimeoutMs).toBeGreaterThan(0);
  });

  it('socket muet : la requête échoue vite avec les bornes', async () => {
    const pool = new Pool(poolConfig(url, { connectTimeoutMs: 400, queryTimeoutMs: 400 }));
    const debut = Date.now();
    await expect(pool.query('select 1')).rejects.toThrow(/timeout/i);
    expect(Date.now() - debut).toBeLessThan(3_000);
    await pool.end().catch(() => {});
  });

  it('contrôle : sans borne, la même requête est encore pendante après 1,5 s', async () => {
    const pool = new Pool({ connectionString: url });
    let fini = false;
    pool.query('select 1').then(
      () => (fini = true),
      () => (fini = true),
    );
    await new Promise((r) => setTimeout(r, 1_500));
    expect(fini).toBe(false);
    void pool.end().catch(() => {});
  });

  it('le client Prisma du Hub passe bien ces bornes à l\'adaptateur', async () => {
    vi.resetModules();
    const recu: unknown[] = [];
    vi.doMock('@prisma/adapter-pg', () => ({ PrismaPg: class { constructor(c: unknown) { recu.push(c); } } }));
    vi.doMock('@prisma/client', () => ({ PrismaClient: class { $connect() {} } }));
    const avant = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://hub:x@127.0.0.1:1/hub';
    try {
      const { prisma } = await import('@/lib/prisma');
      void (prisma as unknown as { $connect: unknown }).$connect;
      expect(recu[0]).toMatchObject({ connectionTimeoutMillis: 10_000, query_timeout: 60_000, keepAlive: true });
    } finally {
      if (avant === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = avant;
      vi.doUnmock('@prisma/adapter-pg');
      vi.doUnmock('@prisma/client');
      (globalThis as { prisma?: unknown }).prisma = undefined;
    }
  });
});
