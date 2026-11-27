/**
 * GET /api/admin/comptes-sans-preuve : recensement, en lecture seule, des comptes dont l'adresse n'a jamais été
 * prouvée (S0, VER-228, M2 de SSO-ORGANISATIONS.md). Ce sont les comptes qu'une pré-prise de compte a pu créer :
 * ceux qui portent un lien OAuth sans preuve sont à trancher un par un (données clients : décision de Robert).
 * Rien n'est modifié ici. Admin seulement. `hub comptes-sans-preuve`.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const garde = await authenticateAdmin(req);
  if (!garde.ok) return garde.response;

  const comptes = await prisma.user.findMany({
    where: { emailVerified: null },
    select: { id: true, email: true, createdAt: true, supabaseUserId: true, sessionsValidAfter: true, accounts: { select: { provider: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const ids = comptes.map((c) => c.supabaseUserId).filter((x): x is string => Boolean(x));
  const tenants = ids.length
    ? await prisma.tenant.findMany({ where: { userId: { in: ids }, deletedAt: null }, select: { userId: true } })
    : [];
  const parUtilisateur = new Map<string, number>();
  for (const t of tenants) parUtilisateur.set(t.userId, (parUtilisateur.get(t.userId) ?? 0) + 1);

  const lignes = comptes.map((c) => {
    const fournisseurs = Array.from(new Set(c.accounts.map((a) => a.provider))).sort();
    const oauth = fournisseurs.filter((f) => f !== 'credentials');
    return {
      hub_user_id: c.supabaseUserId,
      email: c.email,
      cree_le: c.createdAt.toISOString(),
      fournisseurs,
      // Un lien OAuth sur un compte jamais prouvé : la forme exacte d'une pré-prise de compte possible.
      lien_oauth_sans_preuve: oauth.length > 0,
      mot_de_passe: fournisseurs.includes('credentials'),
      tenants: c.supabaseUserId ? (parUtilisateur.get(c.supabaseUserId) ?? 0) : 0,
      sessions_coupees_le: c.sessionsValidAfter?.toISOString() ?? null,
    };
  });
  return NextResponse.json({
    releve_le: new Date().toISOString(),
    total: lignes.length,
    avec_lien_oauth: lignes.filter((l) => l.lien_oauth_sans_preuve).length,
    comptes: lignes,
  });
}
