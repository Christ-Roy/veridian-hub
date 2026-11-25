/** Les adresses de la personne connectée (VER-227 S1b). GET : la liste. POST : demander un code, le confirmer, détacher. Preuve récente, jamais une session d'emprunt. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { adressesProuvees, confirmerCode, demanderCode, detacher } from '@/lib/adresses';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { getCurrentUser } from '@/lib/auth/get-user';
import { denyIfImpersonated, denyUnlessRecentAuth, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Adresse = z.string().max(254).transform(normaliserEmail).pipe(z.string().email());
const Corps = z.discriminatedUnion('geste', [
  z.strictObject({ geste: z.literal('demander'), email: Adresse }),
  z.strictObject({ geste: z.literal('confirmer'), email: Adresse, code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({ geste: z.literal('detacher'), email: Adresse }),
]);
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

async function personne() {
  const u = await getCurrentUser();
  return u ? prisma.user.findUnique({ where: { id: u.id }, select: { id: true, email: true, emailVerified: true } }) : null;
}

export async function GET() {
  const u = await personne();
  if (!u) return rendre({ error: 'unauthorized' }, 401);
  const prouvees = await adressesProuvees(prisma, u);
  return rendre({ principale: u.email, principale_prouvee: Boolean(u.emailVerified), secondaires: prouvees.filter((e) => e !== normaliserEmail(u.email)) });
}

export async function POST(request: NextRequest) {
  const u = await personne();
  if (!u) return rendre({ error: 'unauthorized' }, 401);
  const refus = (await denyIfImpersonated()) ?? (await denyUnlessRecentAuth(PREUVE_COMPTE_S));
  if (refus) return refus;
  // Une adresse non prouvée ne donne aucun droit, pas même celui d'en ajouter une.
  if (!u.emailVerified) return rendre({ error: 'email_not_verified' }, 403);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!c.success) return rendre({ error: 'invalid' }, 400);
  const d = c.data;
  if (d.geste === 'demander') {
    const r = await demanderCode(prisma, u, d.email);
    return r === 'trop' ? rendre({ error: 'rate_limited' }, 429) : rendre({ ok: true });
  }
  if (d.geste === 'confirmer') {
    const r = await confirmerCode(prisma, u, d.email, d.code);
    return r === 'ajoutee' ? rendre({ ok: true }) : rendre({ error: r }, r === 'prise' ? 409 : 400);
  }
  return (await detacher(prisma, u, d.email)) ? rendre({ ok: true }) : rendre({ error: 'not_found' }, 404);
}
