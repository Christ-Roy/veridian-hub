/**
 * POST /api/account/sessions/revoke-all : « se déconnecter partout ».
 *
 * Coupe toutes les sessions du compte au Hub (`sessions_valid_after`), y compris celle-ci, et
 * demande aux apps de couper les leurs. Contrat : CONTRAT-HUB §3.8.
 */

import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth/get-user';
import { revokeAllSessions } from '@/lib/auth/session-revocation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }
  await revokeAllSessions(prisma, user);
  return NextResponse.json({ ok: true });
}
