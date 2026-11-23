/**
 * « Mon IA », moteur `cle-api` : une question du composant de chat (docs/MON-IA.md).
 * Vérifie session, adresse prouvée, espace de l'utilisateur, interrupteur, plafonds et session du fil
 * (menace 7), puis appelle le fournisseur avec la clé du client et les outils de la porte MCP. Le fil
 * part dans l'app ; le Hub ne garde que l'audit (outils, jetons, refus), jamais le contenu.
 */
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { NextResponse, type NextRequest } from 'next/server';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { atelierOuvertPourTenant } from '@/lib/ia/atelier';
import { cleEnClair, estActive, estAppChat, moteurActif, ouvrirSession } from '@/lib/ia/branchements';
import { tourAbonnement } from '@/lib/ia/chat-abonnement';
import { CoffreIndisponible, masquer } from '@/lib/ia/coffre';
import { contexteUtilisateur, espaceDe, parJour, parMinute } from '@/lib/ia/contexte';
import { ecrireFil } from '@/lib/ia/fils';
import { refusEspaceHote, verifierEspaceCrm } from '@/lib/ia/espace-crm';
import { refusSiCroisee } from '@/lib/ia/requete';
import { approbationPour, CONSIGNES, modelePour, outilsDeLaPorte, secretApprobation, TOURS_MAX } from '@/lib/ia/moteur';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TAILLE_MAX = 400_000;

export async function POST(req: NextRequest) {
  const croisee = refusSiCroisee(req);
  if (croisee) return croisee;
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  const brut = await req.text();
  if (brut.length > TAILLE_MAX) return NextResponse.json({ error: 'trop_gros' }, { status: 413 });
  const corps = (() => { try { return JSON.parse(brut); } catch { return null; } })() as
    | { app?: unknown; tenantId?: unknown; workspaceId?: unknown; origine?: unknown; sessionId?: unknown; messages?: unknown }
    | null;
  if (!corps || !estAppChat(corps.app) || !Array.isArray(corps.messages)) {
    return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  }
  const app = corps.app;
  const espace = await espaceDe(c.hubUserId, corps.tenantId, { app, workspaceId: corps.workspaceId });
  if (!espace) return NextResponse.json({ error: 'espace_inconnu' }, { status: 404 });
  const triplet = { hubUserId: c.hubUserId, app, tenantId: espace.id };
  // Où ranger le fil : l'origine de l'espace n'est retenue que si c'est un espace du CRM (lib/ia/fils.ts).
  const ou = { workspaceId: espace.workspaceId, origine: typeof corps.origine === 'string' ? corps.origine : null };
  // Menace 8 : le fil (donc les données lues) ne part qu'à l'espace CRM de ce workspace, vérifié auprès de son plugin.
  if (app === 'crm') {
    const verdict = await verifierEspaceCrm(ou.origine, espace.workspaceId ?? '', c.hubUserId);
    if (verdict !== 'ok') {
      await writeAuditLog(prisma, { action: 'ia.refus', actor: c.email, targetType: 'ia_chat', targetId: c.hubUserId, payload: { app, raison: verdict } });
      return refusEspaceHote(verdict);
    }
  }
  if (!(await estActive(prisma, triplet))) return NextResponse.json({ error: 'chat_desactive' }, { status: 403 });

  for (const [lim, nom] of [[parMinute, 'minute'], [parJour, 'jour']] as const) {
    const r = lim.enforce(c.hubUserId);
    if (!r.ok) {
      await writeAuditLog(prisma, { action: 'ia.refus', actor: c.email, targetType: 'ia_chat', targetId: c.hubUserId, payload: { app, raison: `plafond_${nom}` } });
      return NextResponse.json({ error: 'plafond', par: nom }, { status: 429, headers: { 'Retry-After': String(r.retryAfterSeconds) } });
    }
  }

  const moteur = await moteurActif(prisma, c.hubUserId);
  if (!moteur) return NextResponse.json({ error: 'pas_de_branchement' }, { status: 409 });
  // L'abonnement ne sert que dans un espace où il est ouvert (par tenant, fermé par défaut).
  if (moteur === 'claude-code-abonnement' && !(await atelierOuvertPourTenant(prisma as never, espace.id))) {
    return NextResponse.json({ error: 'abonnement_ferme' }, { status: 403 });
  }
  const demandee = typeof corps.sessionId === 'string' ? corps.sessionId : null;
  const session = await ouvrirSession(prisma, triplet, moteur, demandee);
  if (!session) {
    await writeAuditLog(prisma, { action: 'ia.refus', actor: c.email, targetType: 'ia_chat', targetId: c.hubUserId, payload: { app, raison: 'session_etrangere' } });
    return NextResponse.json({ error: 'session_inconnue' }, { status: 403 });
  }

  if (moteur === 'claude-code-abonnement') {
    return tourAbonnement({ app, email: c.email, hubUserId: c.hubUserId, tenantId: espace.id, ...ou, sessionId: session.id, nouvelle: !demandee, messages: corps.messages as UIMessage[] });
  }

  let branche;
  try {
    branche = await cleEnClair(prisma, c.hubUserId);
  } catch (err) {
    if (err instanceof CoffreIndisponible) return NextResponse.json({ error: 'coffre_indisponible' }, { status: 503 });
    throw err;
  }
  if (!branche) return NextResponse.json({ error: 'pas_de_branchement' }, { status: 409 });
  const cles = [branche.cle];

  const messages = corps.messages as UIMessage[];
  const outils = outilsDeLaPorte(prisma, c.qui, espace.id, cles);
  let outilsAppeles = 0;
  const result = streamText({
    model: modelePour(branche.fournisseur, branche.modele, branche.cle),
    system: CONSIGNES,
    messages: await convertToModelMessages(messages, { tools: outils, ignoreIncompleteToolCalls: true }),
    tools: outils,
    stopWhen: stepCountIs(TOURS_MAX),
    toolApproval: { executer_outil: (input) => approbationPour(prisma, c.qui, String((input as { nom?: unknown }).nom ?? '')) },
    experimental_toolApprovalSecret: secretApprobation(),
    onStepEnd: ({ toolCalls }) => {
      outilsAppeles += toolCalls?.length ?? 0;
    },
    onError: ({ error }) => {
      console.error('[ia] chat : erreur du fournisseur', masquer(error instanceof Error ? `${error.name}: ${error.message}` : String(error), cles));
    },
    onFinish: async ({ totalUsage }) => {
      await writeAuditLog(prisma, {
        action: 'ia.reponse',
        actor: c.email,
        targetType: 'ia_chat',
        targetId: c.hubUserId,
        payload: { app, tenant_id: espace.id, session: session.id, fournisseur: branche.fournisseur, modele: branche.modele, outils: outilsAppeles, jetons: totalUsage?.totalTokens ?? null },
      });
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    messageMetadata: ({ part }) => (part.type === 'start' ? { sessionId: session.id } : undefined),
    onError: (error) => masquer(error instanceof Error ? error.message : 'erreur du fournisseur', cles),
    onEnd: async ({ messages: fil }) => {
      const ok = await ecrireFil(app, { sessionId: session.id, hubUserId: c.hubUserId, tenantId: espace.id, ...ou, messages: fil });
      if (!ok) console.warn(JSON.stringify({ tag: '[ia][fil]', level: 'warn', app, session: session.id, msg: "fil non rangé dans l'app" }));
    },
  });
}
