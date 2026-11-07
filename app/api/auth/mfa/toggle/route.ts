import { denyUnlessRecentAuth, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
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
  // D12 : changer la double vérification exige une connexion récente.
  const preuveRecente = await denyUnlessRecentAuth(PREUVE_COMPTE_S);
  if (preuveRecente) return preuveRecente;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
  }

  // Le code email ne sait conclure qu'une connexion par mot de passe (/api/auth/mfa/start) :
  // un compte Google seul, sans mot de passe, serait bloqué à la connexion suivante.
  if (parsed.data.enabled) {
    const motDePasse = await prisma.account.findFirst({
      where: { userId: session.user.id, provider: 'credentials', access_token: { not: null } },
      select: { id: true },
    });
    if (!motDePasse) {
      return NextResponse.json(
        {
          ok: false,
          error: 'password_required',
          message:
            'Définissez d’abord un mot de passe dans vos paramètres : la validation par email s’applique à la connexion par mot de passe.',
        },
        { status: 400 },
      );
    }
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaEnabled: parsed.data.enabled },
  });

  return NextResponse.json({ ok: true, enabled: parsed.data.enabled });
}
