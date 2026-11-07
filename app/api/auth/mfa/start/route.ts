// POST /api/auth/mfa/start : première étape de la connexion par mot de passe (D3).
//
// Vérifie le mot de passe. Sans double vérification : `{ mfa: false }`, le formulaire enchaîne sur
// signIn('credentials'). Avec double vérification : le code part par mail, un cookie signé
// d'étape 1 est posé (5 min, lié à l'utilisateur), et AUCUNE session n'est créée ici : elle ne naît
// qu'à `/api/auth/mfa/verify`, après le code.
//
// Pourquoi pas le callback signIn : Auth.js rend sa redirection avant de créer la session, et le
// cookie d'étape 1 ne peut pas être posé depuis ce callback.

import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { issueAndSendMfaCode, MfaRateLimitError } from '@/lib/mfa';
import { credentialsLoginIpLimiter, extractClientIp } from '@/lib/auth/rate-limit';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { mfaStep1CookieName, MFA_STEP1_TTL_S, signerEtapeUn } from '@/lib/auth/mfa-step1';
import { secureCookiesEnabled } from '@/lib/auth/impersonation';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const ip = extractClientIp(request.headers);
  const rate = credentialsLoginIpLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const email = normaliserEmail(parsed.data.email);
  const user = await prisma.user.findUnique({
    where: { email },
    include: { accounts: true },
  });
  const cred = user?.accounts.find((a) => a.provider === 'credentials');
  const motDePasseValide =
    !!user && !!cred?.access_token && (await bcrypt.compare(parsed.data.password, cred.access_token));
  if (!user || !motDePasseValide) {
    return NextResponse.json({ ok: false, error: 'invalid_credentials' }, { status: 401 });
  }

  if (!user.mfaEnabled) {
    return NextResponse.json({ ok: true, mfa: false });
  }

  try {
    await issueAndSendMfaCode({ id: user.id, email: user.email });
  } catch (err) {
    if (err instanceof MfaRateLimitError) {
      return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
    }
    console.error('[mfa/start] envoi du code impossible', err);
    return NextResponse.json({ ok: false, error: 'send_failed' }, { status: 500 });
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }
  const secure = secureCookiesEnabled();
  const res = NextResponse.json({ ok: true, mfa: true });
  res.cookies.set(mfaStep1CookieName(secure), signerEtapeUn(user.id, Math.floor(Date.now() / 1000), secret), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: MFA_STEP1_TTL_S,
  });
  return res;
}
