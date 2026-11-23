/**
 * Un tour du moteur `claude-code-abonnement` : la question part à l'atelier, son flux (texte, outils,
 * approbations, fin) revient au format de la fenêtre de chat (UI message stream du Vercel AI SDK). Le fil part
 * dans l'app ; le Hub n'en garde que l'audit.
 */
import { createUIMessageStream, createUIMessageStreamResponse, generateId, type UIMessage } from 'ai';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { prisma } from '@/lib/prisma';

import { appelerAtelier } from './atelier';
import { ecrireFil } from './fils';

type Evenement =
  | { type: 'texte'; delta: string }
  | { type: 'outil'; nom: string }
  | { type: 'approbation'; id: string; outil: string; arguments: unknown }
  | { type: 'fin'; etat?: string; jetons?: number }
  | { type: 'erreur'; code: string };

export async function* lireEvenements(corps: ReadableStream<Uint8Array>): AsyncGenerator<Evenement> {
  const lecteur = corps.getReader();
  const dec = new TextDecoder();
  let reste = '';
  for (;;) {
    const { value, done } = await lecteur.read();
    if (done) break;
    reste += dec.decode(value, { stream: true });
    let i;
    while ((i = reste.indexOf('\n')) >= 0) {
      const ligne = reste.slice(0, i).trim();
      reste = reste.slice(i + 1);
      if (ligne) {
        try {
          yield JSON.parse(ligne) as Evenement;
        } catch {
          /* ligne illisible ignorée */
        }
      }
    }
  }
}

function derniereQuestion(messages: UIMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'user');
  return (m?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();
}

export function tourAbonnement(o: {
  app: string;
  email: string;
  hubUserId: string;
  tenantId: string;
  workspaceId?: string | null;
  origine?: string | null;
  sessionId: string;
  nouvelle: boolean;
  messages: UIMessage[];
}): Response {
  const question = derniereQuestion(o.messages);
  const stream = createUIMessageStream({
    originalMessages: o.messages,
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageMetadata: { sessionId: o.sessionId } });
      const r = await appelerAtelier('/tour', { hubUserId: o.hubUserId, tenantId: o.tenantId, sessionId: o.sessionId, nouvelle: o.nouvelle, message: question }, { tenantId: o.tenantId }).catch(() => null);
      if (!r?.ok || !r.body) {
        writer.write({ type: 'error', errorText: 'atelier_injoignable' });
        return;
      }
      const idTexte = generateId();
      let ouvert = false;
      let outils = 0;
      let jetons: number | null = null;
      for await (const e of lireEvenements(r.body)) {
        if (e.type === 'texte') {
          if (!ouvert) writer.write({ type: 'text-start', id: idTexte });
          ouvert = true;
          writer.write({ type: 'text-delta', id: idTexte, delta: e.delta });
        } else if (e.type === 'outil') {
          outils += 1;
          writer.write({ type: 'data-outil', data: { nom: e.nom }, transient: true });
        } else if (e.type === 'approbation') {
          writer.write({ type: 'data-approbation', id: e.id, data: { id: e.id, outil: e.outil, arguments: e.arguments } });
        } else if (e.type === 'erreur') {
          writer.write({ type: 'error', errorText: e.code });
        } else if (e.type === 'fin') {
          jetons = e.jetons ?? null;
        }
      }
      if (ouvert) writer.write({ type: 'text-end', id: idTexte });
      writer.write({ type: 'finish' });
      await writeAuditLog(prisma, {
        action: 'ia.reponse',
        actor: o.email,
        targetType: 'ia_chat',
        targetId: o.hubUserId,
        payload: { app: o.app, tenant_id: o.tenantId, session: o.sessionId, moteur: 'claude-code-abonnement', outils, jetons },
      });
    },
    onEnd: async ({ messages }) => {
      await ecrireFil(o.app, { sessionId: o.sessionId, hubUserId: o.hubUserId, tenantId: o.tenantId, workspaceId: o.workspaceId, origine: o.origine, messages });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
