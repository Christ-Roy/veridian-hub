/** POST /api/delegation/paires { subject_grant } : état des liaisons dont l'app est la source, dans l'organisation de la poignée. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { etatDesPaires, verifierAppel } from '@/lib/delegation/jeton';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ subject_grant: z.string().min(40).max(64) }).strict();
const rendre = (corps: object, status = 200) => NextResponse.json(corps, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  const brut = await request.text();
  if (brut.length > 1_000) return rendre({ error: 'too_large' }, 413);
  const a = await verifierAppel(prisma, request.headers, brut);
  if ('error' in a) return rendre({ error: a.error }, a.statut);
  let json: unknown = null;
  try {
    json = JSON.parse(brut);
  } catch {
    /* refusé juste après */
  }
  const c = Corps.safeParse(json);
  if (!c.success) return rendre({ error: 'invalid_request' }, 400);
  const r = await etatDesPaires(prisma, a.app, c.data.subject_grant);
  return 'error' in r ? rendre({ error: r.error }, r.statut) : rendre({ tenant_id: r.tenantId, paires: r.paires });
}
