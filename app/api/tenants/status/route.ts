import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    let user;
    try {
      user = await requireUser();
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }

    const uuid = userUuid(user);

    const tenant = await prisma.tenant.findFirst({
      where: { userId: uuid },
      select: {
        id: true,
        name: true,
        status: true,
        notifuseWorkspaceSlug: true,
        provisioningLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            level: true,
            message: true,
            service: true,
            metadata: true,
            createdAt: true,
          },
        },
      },
    });

    return Response.json({
      tenant_id: tenant?.id,
      name: tenant?.name,
      status: tenant?.status,
      notifuse: {
        configured: !!tenant?.notifuseWorkspaceSlug,
        slug: tenant?.notifuseWorkspaceSlug,
      },
      logs: tenant?.provisioningLogs ?? [],
    });
  } catch (error: unknown) {
    console.error('[Tenants Status] Error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
