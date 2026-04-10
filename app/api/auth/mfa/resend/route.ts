// POST /api/auth/mfa/resend — demande un nouveau code 2FA.
// Body : { userId: string }
// Rate-limité via la lib (max 5 codes / heure / user).

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { issueAndSendMfaCode, MfaRateLimitError } from '@/lib/mfa';

const bodySchema = z.object({
  userId: z.string().min(1),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, email: true, mfaEnabled: true },
  });

  if (!user || !user.mfaEnabled) {
    // Ne pas divulguer si l'user existe
    return NextResponse.json({ ok: true });
  }

  try {
    await issueAndSendMfaCode({ id: user.id, email: user.email });
  } catch (err) {
    if (err instanceof MfaRateLimitError) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }
    console.error('[mfa/resend] failed', err);
    return NextResponse.json({ ok: false, error: 'send_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
