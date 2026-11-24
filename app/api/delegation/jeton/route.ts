/** POST /api/delegation/jeton : une app échange la poignée d'un utilisateur contre un jeton d'action de 120 s (VER-245 b.2). */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { echanger, verifierAppel } from '@/lib/delegation/jeton';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const Corps = z.object({ grant_type: z.literal(GRANT_TYPE), subject_grant: z.string().min(40).max(64), audience: z.string().max(40), scope: z.string().max(300), motif: z.string().max(80).optional() }).strict();
const refus = (error: string, status: number, retryAfterS?: number) => NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...(retryAfterS ? { 'Retry-After': String(retryAfterS) } : {}) } });

export async function POST(request: NextRequest) {
  const brut = await request.text();
  if (brut.length > 4_000) return refus('too_large', 413);
  const a = await verifierAppel(prisma, request.headers, brut);
  if ('error' in a) return refus(a.error, a.statut);
  let json: unknown = null;
  try {
    json = JSON.parse(brut);
  } catch {
    /* refusé juste après */
  }
  const c = Corps.safeParse(json);
  if (!c.success) return refus('invalid_request', 400);
  const r = await echanger(prisma, a.app, c.data);
  if ('error' in r) return refus(r.error, r.statut, r.retryAfterS);
  return NextResponse.json({ access_token: r.jeton, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: r.expiresIn, tenant_id: r.tenantId, url: r.url }, { headers: { 'Cache-Control': 'no-store' } });
}
