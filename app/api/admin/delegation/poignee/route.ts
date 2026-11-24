/**
 * POST /api/admin/delegation/poignee { email, app } : poignées d'un compte de batterie, pour éprouver l'échange sans l'app source. Elles ne
 * s'émettent que dans les organisations que l'environnement ouvre (`<cible>@test` : marquées de test au Hub).
 * Jamais pour un vrai client en prod : une poignée y naît d'un rebond, donc d'un utilisateur reconnu.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/admin/require-admin';
import { emettrePoignees } from '@/lib/delegation/poignee';
import { prisma } from '@/lib/prisma';
import { isTestAccount } from '@/lib/sync/test-residue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ email: z.string().email().max(254), app: z.enum(['prospection', 'notifuse', 'crm']) });

export async function POST(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  if (!isTestAccount(c.data.email) && process.env.DEPLOY_ENV !== 'staging') return NextResponse.json({ error: 'compte_reel' }, { status: 403 });
  const u = await prisma.user.findFirst({ where: { email: { equals: c.data.email, mode: 'insensitive' } }, select: { supabaseUserId: true } });
  if (!u?.supabaseUserId) return NextResponse.json({ error: 'compte_introuvable' }, { status: 404 });
  return NextResponse.json({ delegations: await emettrePoignees(prisma, { hubUserId: u.supabaseUserId, app: c.data.app }) }, { headers: { 'Cache-Control': 'no-store' } });
}
