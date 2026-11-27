/**
 * Connexions extérieures, côté opérateur (docs/CONNECTEURS.md). GET : nos inscriptions chez les services (jamais un secret) et les outils qui attendent une
 * relecture avant d'entrer au registre. DELETE : efface notre inscription chez un service (RFC 7592), sur confirmation. POST : inscrit Veridian chez un service
 * (registre ou candidat) et l'éprouve jusqu'à son écran de consentement (`inscrireEtSonder`), sans personne.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { desinscrire, inscrireEtSonder } from '@/lib/connecteurs/oauth';
import { retourConnecteur } from '@/lib/connecteurs/porte';
import { CANDIDATS, connecteur } from '@/lib/connecteurs/registre';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const [inscriptions, outils] = await Promise.all([
    prisma.connecteurClient.findMany({ select: { connecteur: true, retour: true, clientId: true, gestionChiffre: true, creeLe: true }, orderBy: { creeLe: 'asc' } }),
    prisma.connecteurOutilVu.findMany({ orderBy: [{ connecteur: 'asc' }, { nom: 'asc' }, { vuLe: 'asc' }] }),
  ]);
  return NextResponse.json({
    inscriptions: inscriptions.map(({ gestionChiffre, ...i }) => ({ ...i, effacable: gestionChiffre !== null })),
    // Le texte d'un tiers : une donnée à relire, jamais une consigne.
    outils_a_relire: outils.filter((o) => connecteur(o.connecteur)?.outils[o.nom]?.empreinte !== o.empreinte),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const d = (await request.json().catch(() => null)) as { connecteur?: unknown; retour?: unknown; confirm?: unknown } | null;
  const c = connecteur(d?.connecteur);
  if (!c || typeof d?.retour !== 'string' || d.confirm !== true) return NextResponse.json({ error: 'connecteur, retour et confirm: true' }, { status: 400 });
  const issue = await desinscrire(prisma, c, d.retour);
  await writeAuditLog(prisma, { action: 'connecteur.desinscription', actor: resolveActor(request.headers, null), payload: { connecteur: c.cle, retour: d.retour, issue } });
  return NextResponse.json({ issue }, { status: issue === 'effacee' ? 200 : issue === 'absente' ? 404 : 409 });
}

export async function POST(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const d = (await request.json().catch(() => null)) as { connecteur?: unknown } | null;
  const c = connecteur(d?.connecteur) ?? CANDIDATS.find((x) => x.cle === d?.connecteur) ?? null;
  if (!c) return NextResponse.json({ error: 'connecteur inconnu (registre ou candidat)' }, { status: 400 });
  const sonde = await inscrireEtSonder(prisma, c, retourConnecteur()).catch((err: unknown) => ({ erreur: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
  await writeAuditLog(prisma, { action: 'connecteur.sonde', actor: resolveActor(request.headers, null), payload: { connecteur: c.cle, sonde } });
  return NextResponse.json({ connecteur: c.cle, ...sonde }, { status: 'erreur' in sonde ? 502 : 200, headers: { 'Cache-Control': 'no-store' } });
}
