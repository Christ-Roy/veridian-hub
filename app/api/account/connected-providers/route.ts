/**
 * GET /api/account/connected-providers
 *
 * Retourne la liste des providers (Account rows) du user authentifié.
 * Utilisé par la page Settings → Account pour afficher la liste des
 * connexions actives (Google, Microsoft, Credentials).
 *
 * Ne retourne JAMAIS les tokens (access/refresh/id) — uniquement les
 * métadonnées safe : provider, providerAccountId (email/sub), type.
 */

import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const accounts = await prisma.account.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      type: true,
    },
    orderBy: { provider: 'asc' },
  });

  return NextResponse.json({
    providers: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      providerAccountId: a.providerAccountId,
      type: a.type,
    })),
  });
}
