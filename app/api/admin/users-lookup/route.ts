/**
 * POST /api/admin/users-lookup
 *
 * Variante POST de `GET /api/admin/users/:email`, exposée pour l'UI admin
 * `/dashboard/admin/lookup`. Le POST + body évite les soucis d'encoding
 * d'emails (`+`, `.`, IDN) dans le path URL.
 *
 * Auth : `authenticateAdmin` (session admin + rate-limit + check
 * impersonation). Le shape de réponse est strictement identique à
 * `GET /api/admin/users/[email]` pour que l'UI puisse cibler les deux
 * routes sans switcher de parser.
 *
 * Read-only. Pas d'audit log (lecture, pas d'effet de bord).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { authenticateAdmin } from '@/lib/admin/authenticate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  // trim() AVANT email() pour accepter les copy-paste avec espaces
  // accidentels. lowercase() avant email() évite "Alice@x.com" qui passe
  // l'email regex mais ne matche pas la convention DB lowercase.
  email: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.string().email({ message: 'invalid email format' }).max(320)),
});

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Le Zod schema a déjà trim+lowercase via le pipe (cf bodySchema)
  const email = parsed.data.email;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      mfaEnabled: true,
      supabaseUserId: true,
      createdAt: true,
      accounts: {
        select: { provider: true, providerAccountId: true, type: true },
      },
      sessions: { select: { expires: true } },
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const tenants = user.supabaseUserId
    ? await prisma.tenant.findMany({
        where: { userId: user.supabaseUserId },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          notifuseWorkspaceSlug: true,
          notifusePlan: true,
          prospectionPlan: true,
          prospectionProvisionedAt: true,
          metadata: true,
          provisionedAt: true,
          createdAt: true,
        },
      })
    : [];

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: user.emailVerified,
      mfa_enabled: user.mfaEnabled,
      supabase_user_id: user.supabaseUserId,
      created_at: user.createdAt,
      providers: user.accounts.map((a) => ({
        provider: a.provider,
        provider_account_id: a.providerAccountId,
        type: a.type,
      })),
      active_sessions: user.sessions.length,
    },
    tenants,
  });
}
