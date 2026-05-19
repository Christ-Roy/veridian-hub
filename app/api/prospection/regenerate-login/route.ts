import { NextResponse } from 'next/server';

import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import {
  createProspectionClientFromEnv,
  ProspectionError,
} from '@/lib/prospection/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/prospection/regenerate-login
 *
 * Regenerates a one-time login URL for the Prospection app.
 * Calls the Prospection provision API (which does an upsert) to get a fresh token.
 */
export async function POST() {
  try {
    let user;
    try {
      user = await requireUser();
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
    const uuid = userUuid(user);

    const client = createProspectionClientFromEnv();
    if (!client) {
      return NextResponse.json(
        { error: 'Prospection not configured' },
        { status: 500 },
      );
    }

    const displayName = user.name || user.email.split('@')[0];

    let data;
    try {
      data = await client.provisionTenant({
        email: user.email,
        name: displayName,
        userId: uuid,
        plan: 'freemium',
      });
    } catch (err) {
      if (err instanceof ProspectionError) {
        console.error(
          '[Prospection Regenerate] API error:',
          err.code,
          err.message,
        );
        return NextResponse.json(
          { error: `Provision failed: ${err.code}` },
          { status: 502 },
        );
      }
      throw err;
    }

    // Update the tenant record with the new token
    const tenant = await prisma.tenant.findFirst({
      where: { userId: uuid },
      select: { id: true },
    });

    if (tenant) {
      const newToken =
        typeof data.login_url === 'string' ? data.login_url.split('t=')[1] ?? null : null;

      try {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            prospectionLoginToken: newToken,
            prospectionLoginTokenCreatedAt: new Date(),
            prospectionLoginTokenUsed: false,
          },
        });
        console.log(`[Prospection Regenerate] Token persisted for tenant ${tenant.id}`);
      } catch (updateErr) {
        const message = updateErr instanceof Error ? updateErr.message : 'unknown';
        console.error(
          '[Prospection Regenerate] Failed to persist token in DB:',
          message,
        );
      }
    } else {
      console.warn(
        `[Prospection Regenerate] No tenant found for user ${uuid} — token not persisted`,
      );
    }

    return NextResponse.json({
      login_url: data.login_url,
      tenant_id: data.tenant_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('[Prospection Regenerate] Error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
