/**
 * « Mon IA », moteur `claude-code-abonnement` : brancher son abonnement Claude (docs/MON-IA.md).
 * Le client se connecte lui-même chez Anthropic : le Hub ne fait que relayer l'adresse de connexion et le code
 * qu'Anthropic lui affiche, tapé tel quel dans le binaire de l'atelier. Aucun jeton ne passe par le Hub.
 * Ouvert aux comptes dont un espace a l'abonnement ouvert (`hub ia atelier ouvrir <tenant>`), fermé par défaut.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { abonnementOuvertCompte, appelerAtelier, atelierConfigure, FOURNISSEUR_ABONNEMENT, MOTEUR_ABONNEMENT } from '@/lib/ia/atelier';
import { contexteUtilisateur } from '@/lib/ia/contexte';
import { refusSiCroisee } from '@/lib/ia/requete';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = { debut: '/connexion/debut', code: '/connexion/code', statut: '/connexion/statut', fin: '/connexion/fin', approbation: '/approbation' } as const;

export async function POST(req: NextRequest) {
  const croisee = refusSiCroisee(req);
  if (croisee) return croisee;
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  if (!(await abonnementOuvertCompte(prisma as never, c.hubUserId))) return NextResponse.json({ error: 'abonnement_ferme' }, { status: 403 });
  if (!atelierConfigure()) return NextResponse.json({ error: 'atelier_indisponible' }, { status: 503 });
  const corps = (await req.json().catch(() => null)) as { action?: string; code?: unknown; id?: unknown; ok?: unknown } | null;
  const action = corps?.action as keyof typeof ACTIONS | undefined;
  if (!action || !(action in ACTIONS)) return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });

  const charge: Record<string, unknown> = { hubUserId: c.hubUserId };
  if (action === 'code') charge.code = corps?.code;
  if (action === 'approbation') Object.assign(charge, { id: corps?.id, ok: corps?.ok === true });

  const r = await appelerAtelier(ACTIONS[action], charge).catch(() => null);
  if (!r) return NextResponse.json({ error: 'atelier_injoignable' }, { status: 502 });
  const j = (await r.json().catch(() => ({}))) as { connecte?: boolean; email?: string | null; abonnement?: string | null; url?: string; error?: string };

  // Le branchement n'existe au Hub que si le binaire dit le client connecté ; jamais de jeton ici.
  if ((action === 'code' || action === 'statut') && r.ok && j.connecte) {
    await prisma.iaBranchement.upsert({
      where: { hubUserId_fournisseur: { hubUserId: c.hubUserId, fournisseur: FOURNISSEUR_ABONNEMENT } },
      create: { hubUserId: c.hubUserId, fournisseur: FOURNISSEUR_ABONNEMENT, moteur: MOTEUR_ABONNEMENT, modele: j.abonnement ?? 'abonnement', cleScellee: '', cleEmpreinte: '', cleFin: '' },
      update: { modele: j.abonnement ?? 'abonnement' },
    });
    if (action === 'code') {
      await writeAuditLog(prisma, { action: 'ia.branchement', actor: c.email, targetType: 'ia_branchement', targetId: c.hubUserId, payload: { moteur: MOTEUR_ABONNEMENT } });
    }
  }
  if (action === 'fin' && r.ok) {
    await prisma.iaBranchement.deleteMany({ where: { hubUserId: c.hubUserId, fournisseur: FOURNISSEUR_ABONNEMENT } });
    await writeAuditLog(prisma, { action: 'ia.revocation', actor: c.email, targetType: 'ia_branchement', targetId: c.hubUserId, payload: { moteur: MOTEUR_ABONNEMENT } });
  }
  return NextResponse.json(j, { status: r.status });
}
