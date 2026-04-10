// POST /api/auth/mfa/verify — vérifie un code 2FA saisi par l'user sur
// /auth/mfa et, si OK, marque le user comme "mfa passed" via un cookie
// temporaire puis redirige vers le flow de création de session Auth.js.
//
// Flow complet :
// 1. User arrive sur /auth/mfa?uid=xxx après redirect depuis signIn callback
// 2. User tape son code 6 chiffres → POST ici
// 3. On valide le code via verifyMfaCode
// 4. Si OK, set un cookie `mfa_passed_<uid>` (httpOnly, 5min) et retourne
//    `{ ok: true }`. Le front redirige vers /api/auth/signin pour relancer
//    le flow, cette fois le signIn callback détecte le cookie et laisse passer.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { verifyMfaCode } from '@/lib/mfa';

const bodySchema = z.object({
  userId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const { userId, code } = parsed.data;

  const ok = await verifyMfaCode(userId, code);
  if (!ok) {
    return NextResponse.json({ ok: false, error: 'invalid_code' }, { status: 401 });
  }

  // Pose un cookie de passage MFA. Le callback signIn le lira au prochain
  // tour pour laisser passer sans re-déclencher l'envoi d'un code.
  const cookieStore = await cookies();
  cookieStore.set(`mfa_passed_${userId}`, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 5, // 5 minutes
    path: '/',
  });

  return NextResponse.json({ ok: true });
}
