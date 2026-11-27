import { describe, expect, it } from 'vitest';

import { analyserMessageRecu, nomAffiche } from '@/lib/evenements/filtre';

const ev = (data: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({ id: 'liv-1', type: 'message.received', workspace_id: 'ws1', timestamp: '2026-11-24T16:49:52Z', data: { message_id: 'm-1', rfc_message_id: 'ABC@mail.test', kind: 'reply_human', match_type: 'message_id', direction: 'in', email: 'Contact@Exemple.test', thread_id: 't_1', subject: 'Re: secret', from: 'contact@exemple.test', event_timestamp: '2026-11-24T16:49:50Z', ...data }, ...o });

describe('analyserMessageRecu', () => {
  it('une vraie réponse humaine rattachée passe, adresse et Message-ID normalisés', () => {
    expect(analyserMessageRecu(ev())).toEqual({ statut: 'reponse', reponse: { workspaceId: 'ws1', evenementId: 'liv-1', matchType: 'message_id', messageId: 'm-1', rfcMessageId: 'abc@mail.test', email: 'contact@exemple.test', threadId: 't_1', survenuLe: '2026-11-24T16:49:50Z', nom: null } });
    expect(analyserMessageRecu(ev({ match_type: 'subject' })).statut).toBe('reponse');
  });
  it('jamais l\'objet, l\'expéditeur ni le corps dans ce qui est retenu', () => {
    const s = JSON.stringify(analyserMessageRecu(ev({ body: 'corps confidentiel' })));
    for (const m of ['secret', 'confidentiel', 'from']) expect(s).not.toContain(m);
  });
  it('rebond, accusé, réponse automatique, DSN, autre : ignorés', () => {
    for (const kind of ['bounce_hard', 'bounce_soft', 'reply_auto', 'dsn', 'other']) expect(analyserMessageRecu(ev({ kind }))).toEqual({ statut: 'ignore', raison: `kind_${kind}` });
    expect(analyserMessageRecu(ev({ kind: undefined })).statut).toBe('ignore');
  });
  it('un contact qui écrit sans répondre (sender), non rattaché (null), sortant, autre type : ignorés', () => {
    expect(analyserMessageRecu(ev({ match_type: 'sender' }))).toEqual({ statut: 'ignore', raison: 'non_rattache' });
    expect(analyserMessageRecu(ev({ match_type: null })).statut).toBe('ignore');
    expect(analyserMessageRecu(ev({ direction: 'out' }))).toEqual({ statut: 'ignore', raison: 'sortant' });
    expect(analyserMessageRecu(ev({}, { type: 'email.replied' }))).toEqual({ statut: 'ignore', raison: 'type_autre' });
  });
  it('forme cassée : invalide ; adresse non valable : ignoré', () => {
    for (const x of [null, 'x', { id: 1 }, ev({ message_id: undefined }), ev({}, { workspace_id: '' })]) expect(analyserMessageRecu(x).statut).toBe('invalide');
    expect(analyserMessageRecu(ev({ email: 'pas une adresse' }))).toEqual({ statut: 'ignore', raison: 'email_invalide' });
  });
});

describe('nomAffiche', () => {
  it('garde un nom propre, retire contrôles et chevrons, refuse une adresse ou un vide ; relayé depuis from_name', () => {
    expect([nomAffiche('  Alice\u0000  Martin '), nomAffiche('"Bob" <bob@x.fr>'), nomAffiche('bob@x.fr'), nomAffiche('   '), nomAffiche(null), nomAffiche('x'.repeat(300))?.length]).toEqual(['Alice Martin', null, null, null, null, 200]);
    const r = analyserMessageRecu({ id: 'l', type: 'message.received', workspace_id: 'w', data: { message_id: 'm', kind: 'reply_human', match_type: 'message_id', email: 'a@b.fr', from_name: 'Alice Martin' } });
    expect(r.statut === 'reponse' && r.reponse.nom).toBe('Alice Martin');
  });
});
