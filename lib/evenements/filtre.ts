/**
 * Ce que le Hub retient d'un `message.received` de Notifuse : une VRAIE réponse humaine à un envoi (`kind = reply_human` ET `match_type` dans
 * message_id, subject ; BOITE-UNIFIEE.md). Rebonds, accusés, réponses automatiques, DSN, contacts qui écrivent sans répondre : ignorés.
 * On ne copie jamais l'objet, l'expéditeur ni le corps : l'événement est un signal, le CRM relit chez Notifuse.
 */
import { z } from 'zod';

export type Reponse = { workspaceId: string; evenementId: string; matchType: 'message_id' | 'subject'; messageId: string; rfcMessageId: string | null; email: string; threadId: string | null; survenuLe: string | null; nom: string | null };
export type Analyse = { statut: 'invalide' } | { statut: 'ignore'; raison: string } | { statut: 'reponse'; reponse: Reponse };

const Texte = z.string().min(1).max(512);
const Evenement = z.object({
  id: Texte,
  type: z.string().max(64),
  workspace_id: Texte,
  data: z.object({
    message_id: Texte.optional(),
    rfc_message_id: z.string().max(998).nullish(),
    kind: z.string().max(32).optional(),
    match_type: z.string().max(32).nullish(),
    direction: z.string().max(8).optional(),
    email: z.string().max(254).optional(),
    thread_id: z.string().max(128).nullish(),
    event_timestamp: z.string().max(64).nullish(),
    // Nom affiché de l'expéditeur (« Prénom Nom »), pour que la fiche CRM ne reste pas sans nom (VER-247, parente 26/11).
    from_name: z.string().max(400).nullish(),
  }),
});

export function analyserMessageRecu(json: unknown): Analyse {
  const p = Evenement.safeParse(json);
  if (!p.success) return { statut: 'invalide' };
  const { id, type, workspace_id: workspaceId, data: d } = p.data;
  if (type !== 'message.received') return { statut: 'ignore', raison: 'type_autre' };
  if (d.kind !== 'reply_human') return { statut: 'ignore', raison: `kind_${(d.kind ?? 'absent').replace(/\W/g, '')}` };
  if (d.match_type !== 'message_id' && d.match_type !== 'subject') return { statut: 'ignore', raison: 'non_rattache' };
  if (d.direction && d.direction !== 'in') return { statut: 'ignore', raison: 'sortant' };
  const email = (d.email ?? '').trim().toLowerCase();
  if (!d.message_id) return { statut: 'invalide' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { statut: 'ignore', raison: 'email_invalide' };
  return { statut: 'reponse', reponse: { workspaceId, evenementId: id, matchType: d.match_type, messageId: d.message_id, rfcMessageId: d.rfc_message_id?.trim().toLowerCase() || null, email, threadId: d.thread_id ?? null, survenuLe: d.event_timestamp ?? null, nom: nomAffiche(d.from_name) } };
}

/** Un nom affiché propre : sans caractères de contrôle ni guillemets d'en-tête, 200 caractères au plus ; vide ou une adresse : rien. */
export function nomAffiche(brut: string | null | undefined): string | null {
  const n = (brut ?? '').replace(/[\u0000-\u001f\u007f"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return n && !n.includes('@') ? n : null;
}
