import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import pkg from '../../../package.json';

export const dynamic = 'force-dynamic';

const DATABASE_TIMEOUT_MS = 2_000;
const packageVersion =
  'version' in pkg && typeof pkg.version === 'string' ? pkg.version : 'unknown';

// SHA du commit construit, injecte par la CI (`--build-arg GIT_SHA`) : dit quelle version sert vraiment.
function appVersion(): string {
  const sha = process.env.HUB_GIT_SHA?.trim();
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : packageVersion;
}

async function checkDatabase(): Promise<'ok' | 'ko'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1 AS ok`,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('database health check timed out')),
          DATABASE_TIMEOUT_MS
        );
      }),
    ]);
    return 'ok';
  } catch {
    return 'ko';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Health check endpoint for Docker healthcheck
 * GET /api/health
 */
export async function GET() {
  const db = await checkDatabase();
  const status = db === 'ok' ? 'ok' : 'down';

  return NextResponse.json(
    {
      status,
      version: appVersion(),
      db,
      dependencies: {},
      timestamp: new Date().toISOString(),
      service: 'web-dashboard',
    },
    { status: status === 'down' ? 503 : 200 }
  );
}
