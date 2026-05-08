import { NextResponse } from 'next/server';

import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

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

    const PROSPECTION_URL = process.env.PROSPECTION_API_URL;
    const PROSPECTION_SECRET = process.env.PROSPECTION_TENANT_API_SECRET;

    if (!PROSPECTION_URL || !PROSPECTION_SECRET) {
      return NextResponse.json(
        { error: 'Prospection not configured' },
        { status: 500 },
      );
    }

    const displayName = user.name || user.email.split('@')[0];

    // Call provision endpoint (upsert — creates a new token each time)
    const res = await fetch(`${PROSPECTION_URL}/api/tenants/provision`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PROSPECTION_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        name: displayName,
        plan: 'freemium',
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[Prospection Regenerate] API error:', res.status, errorText);
      return NextResponse.json(
        { error: `Provision failed: ${res.status}` },
        { status: 502 },
      );
    }

    const data = await res.json();

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
