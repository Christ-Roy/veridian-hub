import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/grant-plan
 * Body: { email: string, plan: "pro" | "enterprise" | "freemium" }
 *
 * Security: ADMIN_SECRET header OR authenticated admin email
 */
export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  let body: { email?: string; plan?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { email, plan } = body;
  if (!email || !plan) {
    return NextResponse.json({ error: 'email and plan required' }, { status: 400 });
  }
  if (!['freemium', 'pro', 'enterprise'].includes(plan)) {
    return NextResponse.json(
      { error: 'plan must be freemium, pro, or enterprise' },
      { status: 400 },
    );
  }

  // Find user by email
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true },
  });
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }
  if (!user.supabaseUserId) {
    return NextResponse.json(
      { error: `User ${email} has no UUID bridge — cannot resolve tenant` },
      { status: 409 },
    );
  }

  // Update tenant prospection_plan (one tenant per user assumption preserved)
  const tenant = await prisma.tenant.findFirst({
    where: { userId: user.supabaseUserId },
    select: { id: true },
  });
  if (!tenant) {
    return NextResponse.json(
      { error: `No tenant found for user ${email}` },
      { status: 404 },
    );
  }

  const updated = await prisma.tenant.update({
    where: { id: tenant.id },
    data: { prospectionPlan: plan },
    select: { id: true, name: true, prospectionPlan: true },
  });

  return NextResponse.json({
    ok: true,
    user_id: user.supabaseUserId,
    email,
    plan,
    tenant_id: updated.id,
    tenant_name: updated.name,
  });
}
