/** La garde de `obligation.ts` pour une requête du Hub : la session courante est la preuve. */
import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

import { estFermee, fermees, preuveDeSession, type Fermee, type Preuve } from './obligation';

export const PAGE_ORGANISATION = '/auth/organisation';

export const preuveIci = async (): Promise<Preuve> => preuveDeSession(await auth());

/** Les organisations de cette personne que SA session n'ouvre pas. */
export async function fermeesIci(u: { supabaseUserId: string | null }): Promise<Fermee[]> {
  return u.supabaseUserId ? fermees(prisma, u.supabaseUserId, await preuveIci()) : [];
}

export const fermeeIci = async (hubUserId: string, tenantId: string): Promise<boolean> => estFermee(prisma, hubUserId, await preuveIci(), tenantId);

export const reponseFermee = (): NextResponse =>
  NextResponse.json({ error: 'organisation_fournisseur', message: 'Votre organisation demande de passer par son fournisseur de connexion.', ouvrir: PAGE_ORGANISATION }, { status: 403, headers: { 'Cache-Control': 'no-store' } });

/** Les écrans et routes qui lisent « l'espace dont je suis propriétaire » : fermés si l'un d'eux l'est. `null` : ouvert. */
export async function refusSiMienneFermee(u: { supabaseUserId: string | null }): Promise<NextResponse | null> {
  return (await fermeesIci(u)).some((f) => f.proprietaire) ? reponseFermee() : null;
}
