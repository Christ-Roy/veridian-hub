/**
 * POST /api/account/password
 *
 * Change le mot de passe du user authentifié (Auth.js v5).
 * Le password est stocké en bcrypt dans `Account.access_token` pour le
 * provider 'credentials' (cf. auth.ts).
 *
 * Body : { newPassword: string (min 6) }
 *
 * Cas d'usage :
 * - User a un Account 'credentials' -> on update access_token (hash bcrypt)
 * - User n'a PAS encore d'Account 'credentials' (login Google uniquement)
 *   -> on en crée un, ce qui leur permet de se login aussi par
 *   email/password à l'avenir.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

const bodySchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters long'),
});

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const { newPassword } = parsed.data;
  const hash = await bcrypt.hash(newPassword, 12);

  // Cherche un account credentials existant pour ce user
  const credentialsAccount = await prisma.account.findFirst({
    where: {
      userId: user.id,
      provider: 'credentials',
    },
  });

  if (credentialsAccount) {
    // Vérifie que le nouveau password est différent de l'ancien (UX classique)
    if (credentialsAccount.access_token) {
      try {
        const sameAsOld = await bcrypt.compare(newPassword, credentialsAccount.access_token);
        if (sameAsOld) {
          return NextResponse.json(
            { error: 'New password must be different from your current password' },
            { status: 400 },
          );
        }
      } catch {
        // mauvais hash en DB ? on continue, ça repart à zero
      }
    }

    await prisma.account.update({
      where: { id: credentialsAccount.id },
      data: { access_token: hash },
    });
  } else {
    // Pas encore d'account credentials -> on en crée un (utile pour les
    // users Google qui veulent activer un fallback password)
    await prisma.account.create({
      data: {
        userId: user.id,
        type: 'credentials',
        provider: 'credentials',
        providerAccountId: user.email,
        access_token: hash,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
