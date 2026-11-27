/**
 * POST { email } : par où se connecte une adresse, d'après son SEUL domaine (VER-261). Aucun compte n'est lu : une adresse inconnue et une connue ont la même
 * réponse. Le domaine choisit la méthode, il ne prouve rien.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { ipClient } from '@/lib/auth/ip-client';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { aiguiller } from '@/lib/federation/connexion';
import { nomFournisseur } from '@/lib/federation/nom';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.strictObject({ email: z.string().trim().max(254).email() });
const debit = new RateLimiter({ capacity: 60, windowMs: 60_000, name: 'connexion-methode' });
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  if (request.headers.get('origin') !== getHubBaseUrl(request.url).origin) return rendre({ error: 'forbidden_origin' }, 403);
  if (!debit.enforce(ipClient(request.headers)).ok) return rendre({ error: 'rate_limited' }, 429);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!c.success) return rendre({ methode: 'habituelle' });
  try {
    const a = await aiguiller(prisma, c.data.email);
    if (!a) return rendre({ methode: 'habituelle' });
    const i = await prisma.tenantIdp.findUnique({ where: { tenantId: a.tenantId }, select: { issuer: true } });
    return rendre({ methode: 'fournisseur', fournisseur: nomFournisseur(i?.issuer ?? ''), vers: `/connexion/${a.porte}` });
  } catch (err) {
    // Une lecture ratée n'empêche pas de se connecter : la porte de l'organisation, elle, reste fermée.
    console.error('[connexion] methode', err instanceof Error ? err.message.slice(0, 160) : 'erreur');
    return rendre({ methode: 'habituelle' });
  }
}
