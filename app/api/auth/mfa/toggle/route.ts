// POST /api/auth/mfa/toggle — active ou désactive le 2FA email pour l'user
// courant. Nécessite une session valide (Auth.js).

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

const bodySchema = z.object({
  enabled: z.boolean(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaEnabled: parsed.data.enabled },
  });

  return NextResponse.json({ ok: true, enabled: parsed.data.enabled });
}
