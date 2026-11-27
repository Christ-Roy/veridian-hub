/** POST : un lien d'activation expiré demande le suivant (VER-104). Le mail part à l'adresse du compte, la réponse ne dit ni adresse ni lien. */
import { NextRequest, NextResponse } from 'next/server';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { extractClientIp, renouvellementIpLimiter, renouvellementLienLimiter } from '@/lib/auth/rate-limit';
import { renouvelerLienActivation } from '@/lib/onboarding/service';
import { hashOnboardingToken } from '@/lib/onboarding/tokens';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUT = { envoye: 200, encore_valable: 409, actif: 409, invalide: 404 } as const;

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parIp = (await renouvellementIpLimiter.enforceWithBypass(extractClientIp(request.headers), request.headers));
  const trop = !parIp.ok ? parIp : (await renouvellementLienLimiter.enforceWithBypass(hashOnboardingToken(token), request.headers));
  if (!trop.ok) return NextResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(trop.retryAfterSeconds) } });

  const r = await renouvelerLienActivation(prisma, token);
  if (r.issue === 'envoye') {
    await writeAuditLog(prisma, { action: 'onboarding.lien_renouvele', actor: 'system:lien-expire', targetType: 'user', targetId: r.userId ?? '', payload: {} });
  }
  return NextResponse.json({ code: r.issue }, { status: STATUT[r.issue] });
}
