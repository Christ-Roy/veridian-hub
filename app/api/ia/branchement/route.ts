/**
 * « Mon IA » : le branchement de l'IA de l'utilisateur connecté (docs/MON-IA.md). La clé entre ici et
 * n'en ressort jamais : la réponse n'en montre que les 4 derniers caractères.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { brancher, branchementsDe, estFournisseur, revoquer } from '@/lib/ia/branchements';
import { CoffreIndisponible } from '@/lib/ia/coffre';
import { contexteUtilisateur } from '@/lib/ia/contexte';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  return NextResponse.json({ branchements: await branchementsDe(prisma, c.hubUserId) });
}

export async function POST(req: NextRequest) {
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  const corps = (await req.json().catch(() => null)) as { fournisseur?: unknown; modele?: unknown; cle?: unknown } | null;
  if (!corps || !estFournisseur(corps.fournisseur) || typeof corps.cle !== 'string') {
    return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  }
  try {
    const v = await brancher(prisma, c.hubUserId, {
      fournisseur: corps.fournisseur,
      modele: typeof corps.modele === 'string' ? corps.modele : null,
      cle: corps.cle,
    });
    await writeAuditLog(prisma, {
      action: 'ia.branchement',
      actor: c.email,
      targetType: 'ia_branchement',
      targetId: c.hubUserId,
      payload: { fournisseur: v.fournisseur, modele: v.modele, cle_fin: v.cleFin },
    });
    return NextResponse.json({ branchement: v });
  } catch (err) {
    if (err instanceof CoffreIndisponible) return NextResponse.json({ error: 'coffre_indisponible' }, { status: 503 });
    if (err instanceof Error && err.message === 'cle_invalide') return NextResponse.json({ error: 'cle_invalide' }, { status: 400 });
    console.error('[ia] branchement : échec', err instanceof Error ? err.name : 'erreur'); // jamais le message : il peut porter la clé
    return NextResponse.json({ error: 'erreur_interne' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  const fournisseur = req.nextUrl.searchParams.get('fournisseur');
  if (!estFournisseur(fournisseur)) return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  const ok = await revoquer(prisma, c.hubUserId, fournisseur);
  await writeAuditLog(prisma, { action: 'ia.revocation', actor: c.email, targetType: 'ia_branchement', targetId: c.hubUserId, payload: { fournisseur } });
  return NextResponse.json({ revoque: ok });
}
