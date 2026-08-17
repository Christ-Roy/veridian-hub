import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { prisma } from '@/lib/prisma';
import { createOnboardingInvitation } from '@/lib/onboarding/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email(),
  apps: z
    .array(z.enum(['hub', 'notifuse', 'prospection', 'analytics', 'cms', 'crm']))
    .default(['hub']),
  invitedBy: z.string().min(1).max(120).optional(),
  sendEmail: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const actor = resolveActor(request.headers, authResult.sessionEmail);

  try {
    const result = await createOnboardingInvitation(prisma, {
      email: parsed.data.email,
      apps: parsed.data.apps,
      actor,
      invitedBy: parsed.data.invitedBy ?? authResult.sessionEmail ?? 'Veridian',
      sendEmail: parsed.data.sendEmail,
    });

    await writeAuditLog(prisma, {
      action: 'admin.onboarding.invite',
      actor,
      targetType: 'user',
      targetId: result.userId,
      payload: {
        email: result.email,
        apps: result.apps,
        expires_at: result.expiresAt.toISOString(),
        email_sent: result.emailSent,
      },
    });

    return NextResponse.json({
      ok: true,
      user_id: result.userId,
      email: result.email,
      invite_url: result.inviteUrl,
      expires_at: result.expiresAt.toISOString(),
      apps: result.apps,
      email_sent: result.emailSent,
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'user_not_found') {
      return NextResponse.json(
        {
          error: 'user_not_found',
          message: 'Créer le user Hub avant de générer son onboarding.',
        },
        { status: 404 },
      );
    }
    throw err;
  }
}
