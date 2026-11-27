/**
 * Ce que l'atelier peut demander au Hub pour un tour : vérifié comme une question du chat (session du fil liée
 * au triplet, menace 7 ; interrupteur), puis l'outil joué dans l'espace de la conversation, jamais un autre.
 */
import { estFermee } from '@/lib/federation/obligation';
import { prisma } from '@/lib/prisma';
import { MCP_SCOPE } from '@/lib/mcp/config';
import type { Appelant } from '@/lib/mcp/oauth';

import { estActive, ouvrirSession } from './branchements';
import { MOTEUR_ABONNEMENT } from './atelier';

export type DemandeAtelier = { hubUserId: string; tenantId: string; sessionId: string };

export async function appelantPourAtelier(d: Partial<DemandeAtelier> & { app?: string }): Promise<{ qui: Appelant; t: DemandeAtelier } | null> {
  if (typeof d.hubUserId !== 'string' || typeof d.tenantId !== 'string' || typeof d.sessionId !== 'string') return null;
  const session = await prisma.iaSession.findUnique({ where: { id: d.sessionId } }).catch(() => null);
  if (!session || session.hubUserId !== d.hubUserId || session.tenantId !== d.tenantId || session.moteur !== MOTEUR_ABONNEMENT) return null;
  const triplet = { hubUserId: d.hubUserId, app: session.app, tenantId: d.tenantId };
  if (!(await ouvrirSession(prisma, triplet, MOTEUR_ABONNEMENT, d.sessionId))) return null;
  if (!(await estActive(prisma, triplet))) return null;
  // Aucune session ici : l'espace de la conversation se ferme avec lui.
  if (await estFermee(prisma, d.hubUserId, { par: 'personne' }, d.tenantId)) return null;
  const user = await prisma.user.findFirst({ where: { supabaseUserId: d.hubUserId }, select: { id: true, email: true, name: true } });
  if (!user?.email) return null;
  return {
    t: { hubUserId: d.hubUserId, tenantId: d.tenantId, sessionId: d.sessionId },
    qui: { hubUserId: d.hubUserId, clientId: 'mon-ia-atelier', clientName: 'Assistant Veridian', scope: MCP_SCOPE, email: user.email, name: user.name ?? null, userId: user.id, preuve: { par: 'personne' } },
  };
}
