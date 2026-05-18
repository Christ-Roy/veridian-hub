// POST /api/tenants/start
//
// Déclenche le provisioning d'UNE app (ou de toutes) pour le user
// authentifié. Remplace le provisioning automatique au signup : le user
// arrive sur /dashboard et clique "Commencer l'essai" par carte d'app.
//
// Idempotent : si l'app est déjà provisionnée, retourne l'état actuel sans
// rappeler les apps downstream. Ça permet au front d'appeler sans craindre
// les doubles clics ou les refreshes.
//
// Auth : session utilisateur (Auth.js v5). Pas d'admin secret — c'est un
// endpoint user, pas un endpoint d'opération.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { provisionTenants } from '@/utils/tenants/provision';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  app: z.enum(['notifuse', 'prospection', 'all']).default('all'),
});

export async function POST(request: NextRequest) {
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }

  let payload: unknown = {};
  try {
    payload = await request.json();
  } catch {
    // Body vide est valide → on prend les defaults.
    payload = {};
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body — app must be notifuse | prospection | all' },
      { status: 400 },
    );
  }
  const { app } = parsed.data;
  const uuid = userUuid(user);

  // Court-circuit idempotent : si la cible est déjà provisionnée, on renvoie
  // l'état sans rappeler les apps downstream (utile pour double-clic / replay).
  const existing = await prisma.tenant.findFirst({
    where: { userId: uuid },
    select: {
      id: true,
      prospectionProvisionedAt: true,
      notifuseWorkspaceSlug: true,
    },
  });

  const alreadyProvisioned = {
    notifuse: !!existing?.notifuseWorkspaceSlug,
    prospection: !!existing?.prospectionProvisionedAt,
  };

  const askedFor =
    app === 'all'
      ? ['notifuse', 'prospection']
      : [app];
  const allDone = askedFor.every(
    (a) => alreadyProvisioned[a as 'notifuse' | 'prospection'],
  );

  if (allDone) {
    return NextResponse.json({
      ok: true,
      already_provisioned: true,
      tenant_id: existing?.id ?? null,
      ...alreadyProvisioned,
    });
  }

  const result = await provisionTenants(user.email, uuid, { app });

  return NextResponse.json({
    ok: result.success,
    tenant_id: existing?.id ?? null,
    app_requested: app,
    notifuse: result.notifuse
      ? {
          success: result.notifuse.success,
          workspace_id: result.notifuse.workspaceId,
          auto_login_url: result.notifuse.autoLoginUrl,
          error: result.notifuse.error,
        }
      : null,
    prospection: result.prospection
      ? {
          success: result.prospection.success,
          tenant_id: result.prospection.tenantId,
          login_url: result.prospection.loginUrl,
          error: result.prospection.error,
        }
      : null,
    errors: result.errors,
  });
}
