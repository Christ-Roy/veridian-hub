/**
 * POST /api/ia/v1/chat/completions : le fournisseur « Veridian » du chat natif de Twenty (compatible OpenAI, docs/MON-IA.md).
 * Mêmes garde-fous que Mon IA, dans l'ordre : appelant (clé d'instance + identité signée du membre), compte prouvé,
 * espace du membre, interrupteur (retrait volontaire), plafonds, moteur, session liée au fil (menace 7).
 */
import { writeAuditLog } from '@/lib/admin/audit-log';
import { appelerAtelier, atelierOuvertPourTenant } from '@/lib/ia/atelier';
import { cleEnClair, estActive, moteurActif, sessionDerivee } from '@/lib/ia/branchements';
import { lireEvenements } from '@/lib/ia/chat-abonnement';
import { CoffreIndisponible } from '@/lib/ia/coffre';
import { espaceDe, parJour, parMinute } from '@/lib/ia/contexte';
import {
  appelerFournisseur,
  derniereQuestionOpenAI,
  erreurOpenAI,
  morceau,
  relaisAvecMesure,
  sessionDuFil,
  verifierAppel,
  type Identite,
} from '@/lib/ia/fournisseur';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const TAILLE_MAX = 1_000_000;
const APP = 'crm';

async function refuser(qui: Partial<Identite> | null, statut: number, code: string, message: string) {
  await writeAuditLog(prisma, {
    action: 'ia.refus',
    actor: 'crm:fournisseur',
    targetType: 'ia_chat',
    targetId: qui?.hubUserId ?? 'inconnu',
    payload: { app: APP, raison: code, workspace_id: qui?.workspaceId ?? null },
  }).catch(() => {});
  return erreurOpenAI(statut, code, message);
}

export async function POST(req: Request) {
  const qui = await verifierAppel(req.headers);
  if ('refus' in qui) {
    return refuser(null, qui.refus === 'fournisseur_non_configure' ? 503 : 401, qui.refus, 'Authentification refusée.');
  }
  const brut = await req.text();
  if (brut.length > TAILLE_MAX) return erreurOpenAI(413, 'trop_gros', 'Requête trop volumineuse.');
  const corps = (() => {
    try {
      return JSON.parse(brut) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!corps || !Array.isArray(corps.messages)) return erreurOpenAI(400, 'requete_invalide', 'messages attendu.');

  const user = await prisma.user.findFirst({ where: { supabaseUserId: qui.hubUserId }, select: { email: true, emailVerified: true } });
  if (!user?.email || !user.emailVerified) return refuser(qui, 403, 'adresse_non_prouvee', "Ce compte n'a pas d'adresse prouvée.");
  const espace = await espaceDe(qui.hubUserId, null, { app: APP, workspaceId: qui.workspaceId });
  if (!espace) return refuser(qui, 403, 'espace_etranger', "Cet espace n'appartient pas à ce membre.");
  const triplet = { hubUserId: qui.hubUserId, app: APP, tenantId: espace.id };
  if (!(await estActive(prisma, triplet))) return refuser(qui, 403, 'chat_desactive', "L'assistant est éteint pour cette app.");
  for (const [lim, nom] of [[parMinute, 'minute'], [parJour, 'jour']] as const) {
    if (!lim.enforce(qui.hubUserId).ok) return refuser(qui, 429, `plafond_${nom}`, 'Trop de questions en peu de temps.');
  }
  const moteur = await moteurActif(prisma, qui.hubUserId);
  if (!moteur) return refuser(qui, 409, 'pas_de_branchement', "Aucune IA n'est branchée à ce compte Veridian.");
  if (moteur === 'claude-code-abonnement' && !(await atelierOuvertPourTenant(prisma as never, espace.id))) {
    return refuser(qui, 403, 'abonnement_ferme', "L'abonnement n'est pas ouvert pour cet espace.");
  }
  const session = await sessionDerivee(prisma, triplet, moteur, sessionDuFil(triplet, qui.fil));
  if (!session) return refuser(qui, 403, 'session_etrangere', 'Ce fil ne peut pas être repris ici.');

  const audit = (payload: Record<string, unknown>) =>
    writeAuditLog(prisma, {
      action: 'ia.reponse',
      actor: user.email,
      targetType: 'ia_chat',
      targetId: qui.hubUserId,
      payload: { app: APP, tenant_id: espace.id, fil: qui.fil, session: session.id, moteur, ...payload },
    }).catch(() => {});

  // ── Clé API : relais transparent, les outils de Twenty passent tels quels ──
  if (moteur === 'cle-api') {
    let branche;
    try {
      branche = await cleEnClair(prisma, qui.hubUserId);
    } catch (err) {
      if (err instanceof CoffreIndisponible) return erreurOpenAI(503, 'coffre_indisponible', 'Service momentanément indisponible.');
      throw err;
    }
    if (!branche) return refuser(qui, 409, 'pas_de_branchement', "Aucune IA n'est branchée à ce compte Veridian.");
    const r = await appelerFournisseur(branche, corps);
    if ('refus' in r) {
      const statut = r.refus === 'fournisseur_plafond' ? 429 : 502;
      return refuser(qui, statut, r.refus, "Le fournisseur d'IA de ce compte a refusé la demande.");
    }
    if (corps.stream !== true || !r.body) {
      const j = (await r.json().catch(() => null)) as { usage?: { total_tokens?: number } } | null;
      await audit({ fournisseur: branche.fournisseur, modele: branche.modele, jetons: j?.usage?.total_tokens ?? null });
      return Response.json(j ?? {});
    }
    const flux = relaisAvecMesure(r.body, ({ jetons, outils }) => {
      void audit({ fournisseur: branche.fournisseur, modele: branche.modele, jetons, outils });
    });
    return new Response(flux, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }

  // ── Abonnement : la boucle de l'atelier, lecture seule, texte seulement ──
  const question = derniereQuestionOpenAI(corps.messages);
  if (!question) return erreurOpenAI(400, 'question_vide', 'Aucune question.');
  const id = `chatcmpl-${session.id.slice(0, 8)}${Date.now()}`;
  const enc = new TextEncoder();
  const flux = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const w = (s: string) => ctrl.enqueue(enc.encode(s));
      w(morceau(id, { role: 'assistant', content: '' }));
      const r = await appelerAtelier('/tour', { hubUserId: qui.hubUserId, tenantId: espace.id, sessionId: session.id, nouvelle: session.creee, message: question }, { tenantId: espace.id }).catch(() => null);
      let outils = 0;
      let refusees = 0;
      let jetons: number | null = null;
      if (!r?.ok || !r.body) {
        w(morceau(id, { content: "L'assistant est momentanément indisponible (incident de notre côté)." }));
      } else {
        for await (const e of lireEvenements(r.body)) {
          if (e.type === 'texte') w(morceau(id, { content: e.delta }));
          else if (e.type === 'outil') outils += 1;
          else if (e.type === 'approbation') {
            // Pas de fenêtre de confirmation dans le chat natif : toute écriture est refusée (lecture seule).
            refusees += 1;
            await appelerAtelier('/approbation', { hubUserId: qui.hubUserId, id: e.id, ok: false }, { tenantId: espace.id }).catch(() => null);
          } else if (e.type === 'erreur') w(morceau(id, { content: `\n(l'assistant s'est interrompu : ${e.code})` }));
          else if (e.type === 'fin') jetons = e.jetons ?? null;
        }
      }
      if (refusees > 0) w(morceau(id, { content: "\n\nCe chat est en lecture seule : aucune modification n'a été faite dans le CRM." }));
      w(morceau(id, {}, 'stop'));
      w(morceau(id, {}, null, { prompt_tokens: 0, completion_tokens: jetons ?? 0, total_tokens: jetons ?? 0 }));
      w('data: [DONE]\n\n');
      ctrl.close();
      await audit({ outils, ecritures_refusees: refusees, jetons });
    },
  });
  return new Response(flux, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
