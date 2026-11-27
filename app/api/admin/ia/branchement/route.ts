/**
 * « Mon IA », côté administrateur : ranger au coffre la clé d'IA d'un compte, sans qu'elle passe par un navigateur
 * (docs/MON-IA.md). Sert à brancher le compte de Robert depuis le bastion : `hub ia brancher` lit la clé dans
 * `~/credentials` et l'envoie dans le corps de cette requête, jamais dans une URL, un argument ou un journal.
 *
 *   GET    ?email=            → les branchements du compte (fin de clé seulement)
 *   POST   { email, fournisseur, modele?, cle, verifier? } → range la clé (chiffrée), rend la fin de clé
 *   DELETE ?email=&fournisseur= → efface le branchement
 *
 * `verifier: true` demande au fournisseur la liste de ses modèles avec la clé : gratuit, aucune question posée,
 * prouve que la clé est reconnue (pas qu'elle a du crédit).
 *
 * Admin seulement (`authenticateAdmin`). Le compte doit avoir une adresse prouvée, comme pour tout branchement.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { brancher, branchementsDe, FOURNISSEURS, revoquer, type Fournisseur } from '@/lib/ia/branchements';
import { CoffreIndisponible } from '@/lib/ia/coffre';
import { verifierCle } from '@/lib/ia/verifier-cle';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fournisseurs = Object.keys(FOURNISSEURS) as [Fournisseur, ...Fournisseur[]];

const Corps = z.object({
  email: z.string().email(),
  fournisseur: z.enum(fournisseurs),
  modele: z.string().max(120).optional(),
  cle: z.string().min(16).max(400),
  verifier: z.boolean().default(false),
});

async function compte(email: string): Promise<{ hubUserId: string; email: string } | NextResponse> {
  const u = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { email: true, supabaseUserId: true, emailVerified: true },
  });
  if (!u?.supabaseUserId) return NextResponse.json({ error: 'compte_inconnu' }, { status: 404 });
  if (!u.emailVerified) return NextResponse.json({ error: 'adresse_non_prouvee' }, { status: 403 });
  return { hubUserId: u.supabaseUserId, email: u.email };
}

export async function GET(req: NextRequest) {
  const garde = await authenticateAdmin(req);
  if (!garde.ok) return garde.response;
  const c = await compte(req.nextUrl.searchParams.get('email') ?? '');
  if (c instanceof NextResponse) return c;
  return NextResponse.json({ email: c.email, branchements: await branchementsDe(prisma, c.hubUserId) });
}

export async function POST(req: NextRequest) {
  const garde = await authenticateAdmin(req);
  if (!garde.ok) return garde.response;
  const r = Corps.safeParse(await req.json().catch(() => null));
  // Jamais les détails de zod : ils peuvent citer la valeur reçue, donc la clé.
  if (!r.success) return NextResponse.json({ error: 'requete_invalide', champs: r.error.issues.map((i) => i.path.join('.')) }, { status: 400 });
  const c = await compte(r.data.email);
  if (c instanceof NextResponse) return c;

  let verification: Awaited<ReturnType<typeof verifierCle>> | null = null;
  if (r.data.verifier) {
    verification = await verifierCle(r.data.fournisseur, r.data.cle);
    if (verification.etat === 'refusee') return NextResponse.json({ error: 'cle_refusee', verification }, { status: 422 });
  }
  try {
    const v = await brancher(prisma, c.hubUserId, { fournisseur: r.data.fournisseur, modele: r.data.modele ?? null, cle: r.data.cle });
    await writeAuditLog(prisma, {
      action: 'ia.branchement.admin',
      actor: 'admin',
      targetType: 'ia_branchement',
      targetId: c.hubUserId,
      payload: { fournisseur: v.fournisseur, modele: v.modele, cle_fin: v.cleFin, verification: verification?.etat ?? 'non_demandee' },
    });
    return NextResponse.json({ email: c.email, branchement: v, verification });
  } catch (err) {
    if (err instanceof CoffreIndisponible) return NextResponse.json({ error: 'coffre_indisponible' }, { status: 503 });
    if (err instanceof Error && err.message === 'cle_invalide') return NextResponse.json({ error: 'cle_invalide' }, { status: 400 });
    console.error('[ia] branchement admin : échec', err instanceof Error ? err.name : 'erreur'); // jamais le message
    return NextResponse.json({ error: 'erreur_interne' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const garde = await authenticateAdmin(req);
  if (!garde.ok) return garde.response;
  const fournisseur = req.nextUrl.searchParams.get('fournisseur');
  if (!fournisseur || !(fournisseur in FOURNISSEURS)) return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  const c = await compte(req.nextUrl.searchParams.get('email') ?? '');
  if (c instanceof NextResponse) return c;
  const ok = await revoquer(prisma, c.hubUserId, fournisseur as Fournisseur);
  await writeAuditLog(prisma, { action: 'ia.revocation.admin', actor: 'admin', targetType: 'ia_branchement', targetId: c.hubUserId, payload: { fournisseur } });
  return NextResponse.json({ revoque: ok });
}
