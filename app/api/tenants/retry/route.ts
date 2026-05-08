import { NextResponse } from 'next/server';

import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    const user = await requireUser();
    const uuid = userUuid(user);

    // Check what's already provisioned
    const existingTenant = await prisma.tenant.findFirst({
      where: { userId: uuid },
      select: {
        id: true,
        twentyWorkspaceId: true,
        prospectionProvisionedAt: true,
        notifuseWorkspaceSlug: true,
      },
    });

    const alreadyDone = {
      twenty: !!existingTenant?.twentyWorkspaceId,
      prospection: !!existingTenant?.prospectionProvisionedAt,
      notifuse: !!existingTenant?.notifuseWorkspaceSlug,
    };

    if (alreadyDone.twenty && alreadyDone.prospection && alreadyDone.notifuse) {
      return NextResponse.json({
        message: 'All services already provisioned',
        ...alreadyDone,
      });
    }

    console.log(
      `[Retry Provision] Retrying for ${user.email} — current state:`,
      alreadyDone,
    );

    // Re-trigger provisioning (password will be resolved from DB or generated).
    // utils/tenants/provision.ts est refacto par le LOT C — on conserve la
    // signature actuelle (email, password, userId).
    const { provisionTenants } = await import('@/utils/tenants/provision');
    const result = await provisionTenants(user.email, '', uuid);

    return NextResponse.json({
      message: 'Provisioning completed',
      user_id: uuid,
      ...result,
    });
  } catch (error) {
    if (error instanceof Response) {
      // requireUser threw a 401 Response
      return error;
    }
    const message = error instanceof Error ? error.message : 'Provisioning failed';
    console.error('[Retry Provision] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
