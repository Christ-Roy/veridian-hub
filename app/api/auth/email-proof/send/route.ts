// POST /api/auth/email-proof/send : renvoie le lien de preuve au compte connecté.

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import { issueEmailProof } from '@/lib/auth/email-proof';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { emailVerified: true },
  });
  if (row?.emailVerified) {
    return NextResponse.json({ ok: true, already_proved: true });
  }
  try {
    const sent = await issueEmailProof(prisma, user);
    return NextResponse.json({ ok: true, sent });
  } catch (err) {
    console.error('[email-proof] envoi du lien impossible', err);
    return NextResponse.json({ error: 'send_failed' }, { status: 502 });
  }
}
