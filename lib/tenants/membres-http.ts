/** Ce que partagent les routes admin d'appartenance : le tenant, le compte visé, et un refus lisible. */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';

import { RefusMembre } from './membres';

export const IdTenant = z.string().uuid();
export const Compte = z.object({ email: z.string().email().max(254).optional(), hub_user_id: z.string().uuid().optional() }).refine((d) => Boolean(d.email || d.hub_user_id), { message: 'email ou hub_user_id attendu' });

/** hub_user_id du compte visé, depuis son identifiant ou son adresse ; null s'il n'est pas au Hub. */
export async function compteVise(d: { email?: string; hub_user_id?: string }): Promise<string | null> {
  if (d.hub_user_id) return d.hub_user_id;
  const u = await prisma.user.findFirst({ where: { email: { equals: d.email, mode: 'insensitive' } }, select: { supabaseUserId: true } });
  return u?.supabaseUserId ?? null;
}

const STATUTS: Record<RefusMembre['code'], number> = { tenant_introuvable: 404, compte_introuvable: 404, pas_membre: 404, tenant_suspendu: 409, adresse_non_prouvee: 409, proprietaire: 409, retire: 409, role_refuse: 400 };

export function refuser(err: unknown): NextResponse {
  if (err instanceof RefusMembre) return NextResponse.json({ error: err.code === 'proprietaire' ? 'cannot_remove_owner' : err.code }, { status: STATUTS[err.code] });
  console.error('[membres]', err);
  return NextResponse.json({ error: 'echec' }, { status: 500 });
}

/** 200 : fait et relu partout. 207 : fait au Hub, une app au moins n'a pas suivi (rejouer est sans effet de bord). */
export const rendre = (r: { complet: boolean }) => NextResponse.json(r, { status: r.complet ? 200 : 207, headers: { 'Cache-Control': 'no-store' } });
