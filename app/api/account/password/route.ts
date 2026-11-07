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

import { denyIfImpersonated, denyUnlessRecentAuth, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { revokeAllSessions } from '@/lib/auth/session-revocation';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

const bodySchema = z.object({
  // D11 : mêmes bornes qu'à l'inscription. bcrypt ne lit que 72 octets : au-delà, le reste est ignoré.
  newPassword: z
    .string()
    .min(8, 'Le mot de passe doit faire au moins 8 caractères')
    .max(72, 'Le mot de passe doit faire au plus 72 caractères'),
});

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const interdite = await denyIfImpersonated();
  if (interdite) return interdite;
  const denied = await denyUnlessRecentAuth(PREUVE_COMPTE_S);
  if (denied) return denied;

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

  // D11 : un lien de reset encore en attente ne doit pas survivre à un changement par les réglages.
  await prisma.verificationToken.deleteMany({ where: { identifier: user.email } });

  // Un mot de passe changé coupe toutes les sessions, y compris celle-ci et celles des apps.
  const { appsEnEchec } = await revokeAllSessions(prisma, user);

  return NextResponse.json({ ok: true, reconnect: true, apps_failed: appsEnEchec });
}
