import { NextResponse } from 'next/server';

/**
 * Health check endpoint for Docker healthcheck
 * GET /api/health
 */
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'web-dashboard',
    },
    { status: 200 }
  );
}
