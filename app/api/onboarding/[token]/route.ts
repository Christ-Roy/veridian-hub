import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { extractClientIp, onboardingVerifyLimiter } from '@/lib/auth/rate-limit';
import { getOnboardingInviteByToken } from '@/lib/onboarding/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'rate_limited', message: 'Trop de tentatives. Patientez avant de réessayer.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = extractClientIp(request.headers);
  const rate = onboardingVerifyLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) return rateLimited(rate.retryAfterSeconds);

  const { token } = await params;
  const lookup = await getOnboardingInviteByToken(prisma, token);
  if (!lookup.ok) {
    const status = lookup.code === 'expired' ? 410 : 404;
    return NextResponse.json({ ok: false, code: lookup.code }, { status });
  }

  return NextResponse.json({ ok: true, invite: lookup.invite });
}
