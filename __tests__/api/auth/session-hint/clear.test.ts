/**
 * Tests POST /api/auth/session-hint/clear — supprime le cookie hint.
 *
 * Couvre Mode Nuclear :
 *  - 200 toujours (route publique, idempotent même si pas de cookie)
 *  - Set-Cookie avec Max-Age=0
 *  - Scope cookie cohérent avec le set (.veridian.site en prod)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

import { POST } from '@/app/api/auth/session-hint/clear/route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/auth/session-hint/clear', {
    method: 'POST',
  });
}

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.DEPLOY_ENV = 'prod';
});

describe('POST /api/auth/session-hint/clear', () => {
  it('200 et pose un Set-Cookie avec Max-Age=0', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('veridian-session-hint=;');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Domain=.veridian.site');
  });

  it('200 même si pas de cookie en entrée (idempotent)', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });
});

describe('runtime config — clear/route.ts', () => {
  // Verrouille les exports config (dynamic + runtime) : la route DOIT être
  // marquée `force-dynamic` + `nodejs` runtime, sinon Next.js peut la mettre
  // en cache (= cookie clear inopérant côté CDN) ou la basculer en Edge
  // (= incompatible avec libs Node-only utilisées en aval).
  const source = fs.readFileSync(
    path.join(process.cwd(), 'app/api/auth/session-hint/clear/route.ts'),
    'utf8',
  );

  it('export dynamic = "force-dynamic" (anti cache CDN)', () => {
    expect(source).toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/);
  });

  it('export runtime = "nodejs" (la lib cookie utilise des APIs Node)', () => {
    expect(source).toMatch(/export\s+const\s+runtime\s*=\s*['"]nodejs['"]/);
  });
});
