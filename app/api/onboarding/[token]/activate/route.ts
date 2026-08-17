import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { activateOnboarding } from '@/lib/onboarding/service';
import { extractClientIp, onboardingConsumeLimiter } from '@/lib/auth/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  // max 72 bytes utile avec bcrypt. La validation UI demande plus fort, mais
  // l'API garde la borne standard et stable côté sécurité.
  password: z.string().min(8).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= 72,
    { message: 'password_max_72_bytes' },
  ),
});

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'rate_limited', message: 'Trop de tentatives. Patientez avant de réessayer.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = extractClientIp(request.headers);
  const rate = onboardingConsumeLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) return rateLimited(rate.retryAfterSeconds);

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { token } = await params;
  try {
    const result = await activateOnboarding(prisma, {
      token,
      password: parsed.data.password,
    });

    return NextResponse.json({
      ok: true,
      email: result.email,
      user_id: result.userId,
      apps: result.apps,
      provisioning: result.provisioning,
      next: '/dashboard',
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'activation_failed';
    const status = code === 'expired' ? 410 : code === 'invalid' || code === 'activated' ? 400 : 500;
    return NextResponse.json({ ok: false, code }, { status });
  }
}
