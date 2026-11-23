// POST /api/auth/mfa/verify : deuxième étape de la connexion par mot de passe (D3).
//
// Exige le cookie signé d'étape 1 (posé par /api/auth/mfa/start, lié à l'utilisateur et au
// navigateur), vérifie le code (usage unique, 5 essais par fenêtre de 10 min), puis émet la vraie
// session Auth.js : même cookie, mêmes attributs que le reste, `authAt` = début réel de la
// connexion. Le cookie d'étape 1 est effacé. Modèle : app/api/auth/impersonate-callback.

import { NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { z } from 'zod';

import { authConfig } from '@/auth.config';
import { prisma } from '@/lib/prisma';
import { verifyMfaCode } from '@/lib/mfa';
import { PlafondEchecs, poserAppareil } from '@/lib/auth/plafond-compte';
import { lireEtapeUn, mfaStep1CookieName, verifierEtapeUn } from '@/lib/auth/mfa-step1';
import { secureCookiesEnabled, sessionCookieName } from '@/lib/auth/impersonation';
import { safeCallback } from '@/lib/auth/safe-callback';

export const dynamic = 'force-dynamic';

/**
 * Codes faux par utilisateur, quelle que soit l'IP : 5 par 10 minutes (durée de validité du code). Un essai refusé ne
 * prolonge plus le blocage (23/11) ; une réussite rend sa place.
 */
const essaisParUtilisateur = new PlafondEchecs(5, 10 * 60 * 1000);

const bodySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  next: z.string().max(2048).optional(),
});

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const nowS = Math.floor(Date.now() / 1000);
  const uid = verifierEtapeUn(lireEtapeUn(request.headers.get('cookie')), secret, nowS);
  if (!uid) {
    return NextResponse.json({ ok: false, error: 'mfa_step1_required' }, { status: 401 });
  }

  const essai = essaisParUtilisateur.reserver(uid);
  if (!essai.ok) {
    return NextResponse.json(
      { ok: false, error: 'too_many_attempts' },
      { status: 429, headers: { 'Retry-After': String(essai.retryAfterSeconds) } },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  const codeValide = await verifyMfaCode(uid, parsed.data.code);
  if (!codeValide) {
    return NextResponse.json({ ok: false, error: 'invalid_code' }, { status: 401 });
  }
  essai.rendre();

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { id: true, email: true, name: true, image: true },
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: 'mfa_step1_required' }, { status: 401 });
  }

  const sessionJwt = await encode({
    salt: sessionCookieName(),
    secret,
    maxAge: authConfig.session.maxAge,
    token: {
      uid: user.id,
      sub: user.id,
      email: user.email,
      name: user.name ?? null,
      picture: user.image ?? null,
      authAt: nowS,
    },
  });

  const secure = secureCookiesEnabled();
  const res = NextResponse.json({ ok: true, redirect: safeCallback(parsed.data.next) });
  res.cookies.set(sessionCookieName(secure), sessionJwt, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: authConfig.session.maxAge,
  });
  poserAppareil(res, user.email);
  res.cookies.set(mfaStep1CookieName(secure), '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
