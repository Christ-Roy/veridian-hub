/**
 * GET /api/hub/connexions-ia?hub_user_id=<uuid> : assistants IA reliés à ce compte (nom du client,
 * date de connexion, dernière utilisation). Réservé aux apps (HMAC §6.1, `lib/mcp/connexions-apps.ts`).
 * Ni jeton ni adresse dans la réponse.
 */
import { NextRequest, NextResponse } from 'next/server';

import { appSignataire } from '@/lib/mcp/connexions-apps';
import { connexionsActives } from '@/lib/mcp/connexions';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const app = appSignataire(request.headers);
  if (!app) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const hubUserId = request.nextUrl.searchParams.get('hub_user_id') ?? '';
  if (!UUID.test(hubUserId)) return NextResponse.json({ error: 'invalid_hub_user_id' }, { status: 400 });
  const connexions = await connexionsActives(prisma, hubUserId.toLowerCase());
  return NextResponse.json({
    hub_user_id: hubUserId.toLowerCase(),
    connexions: connexions.map((c) => ({
      client: c.client,
      depuis: c.depuis.toISOString(),
      derniere_utilisation: c.derniereUtilisation?.toISOString() ?? null,
    })),
  });
}
