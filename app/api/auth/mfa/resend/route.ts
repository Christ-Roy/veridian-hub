// POST /api/auth/mfa/resend : renvoie le code 2FA (D3).
//
// Ne prend plus d'identifiant dans le corps : l'utilisateur vient du cookie signé d'étape 1
// (posé après le mot de passe). Sans lui, n'importe qui pouvait faire envoyer des codes à une
// adresse dont il ne connaît pas le mot de passe. Limite : 5 codes par heure (lib/mfa).

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { issueAndSendMfaCode, MfaRateLimitError } from '@/lib/mfa';
import { lireEtapeUn, verifierEtapeUn } from '@/lib/auth/mfa-step1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }
  const uid = verifierEtapeUn(lireEtapeUn(request.headers.get('cookie')), secret, Math.floor(Date.now() / 1000));
  if (!uid) {
    return NextResponse.json({ ok: false, error: 'mfa_step1_required' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true, mfaEnabled: true },
  });
  if (!user || !user.mfaEnabled) {
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
