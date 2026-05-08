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
        twentyWorkspaceId: true,
        twentySubdomain: true,
        twentyLoginToken: true,
        twentyLoginTokenCreatedAt: true,
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

    // Calculer si loginToken encore valide (15min - 1min de marge)
    const tokenCreatedAt = tenant?.twentyLoginTokenCreatedAt
      ? new Date(tenant.twentyLoginTokenCreatedAt).getTime()
      : null;
    const twentyTokenValid = !!(
      tenant?.twentyLoginToken &&
      tokenCreatedAt &&
      Date.now() - tokenCreatedAt < 14 * 60 * 1000
    );

    return Response.json({
      tenant_id: tenant?.id,
      name: tenant?.name,
      status: tenant?.status,
      twenty: {
        configured: !!tenant?.twentyWorkspaceId,
        subdomain: tenant?.twentySubdomain,
        workspace_id: tenant?.twentyWorkspaceId,
        login_token_valid: twentyTokenValid,
        login_token: twentyTokenValid ? tenant?.twentyLoginToken : null,
      },
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
