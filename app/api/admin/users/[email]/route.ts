/**
 * GET /api/admin/users/:email
 *
 * Retourne le state complet user + tenants côté Hub. Utile pour vérifier
 * l'idempotence d'un script ou debug.
 *
 * Auth : requireAdmin (session ou x-admin-secret).
 * Read-only. Pas d'audit log (lecture seule, peu intéressant à tracer).
 *
 * Note : Next.js décode automatiquement le param URL — `avse%40gmail.com`
 * arrive dans params comme `avse@gmail.com`. On lowercase pour matcher
 * la convention DB.
 */

import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/admin/require-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ email: string }> }
) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const { email: rawEmail } = await ctx.params;
  const email = rawEmail.trim().toLowerCase();

  if (!email.includes('@')) {
    return NextResponse.json(
      { error: 'invalid_email', message: 'Param :email is not a valid email.' },
      { status: 400 }
    );
  }

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

  // Tenants via la corrélation supabaseUserId
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
