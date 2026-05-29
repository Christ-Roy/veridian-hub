import { NextResponse } from 'next/server';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { getCrmTenantByUserId } from '@/lib/crm/select-tenant';
import { regenerateMagicLink } from '@/lib/crm/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let tenant;
  try {
    tenant = await getCrmTenantByUserId(userUuid(user));
  } catch (err) {
    console.error('[crm/regenerate-magic-link] tenant lookup failed', err);
    return NextResponse.json(
      { error: 'Tenant lookup failed' },
      { status: 500 },
    );
  }

  if (!tenant) {
    return NextResponse.json(
      { error: 'No CRM tenant for this user' },
      { status: 404 },
    );
  }

  if (tenant.status !== 'active') {
    return NextResponse.json(
      { error: `Tenant not active (status=${tenant.status})` },
      { status: 409 },
    );
  }

  try {
    const { magicLinkUrl, expiresAt } = await regenerateMagicLink(tenant.id);
    return NextResponse.json({
      magicLinkUrl,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('[crm/regenerate-magic-link] generation failed', err);
    return NextResponse.json(
      { error: 'Magic-link generation failed' },
      { status: 502 },
    );
  }
}
