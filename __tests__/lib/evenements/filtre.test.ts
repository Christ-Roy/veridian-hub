import { describe, expect, it } from 'vitest';

import { analyserMessageRecu, nomAffiche, normaliserRfc } from '@/lib/evenements/filtre';

const ev = (data: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({ id: 'liv-1', type: 'message.received', workspace_id: 'ws1', timestamp: '2026-11-24T16:49:52Z', data: { message_id: 'm-1', rfc_message_id: 'ABC@mail.test', kind: 'reply_human', match_type: 'message_id', direction: 'in', email: 'Contact@Exemple.test', thread_id: 't_1', subject: 'Re: secret', from: 'contact@exemple.test', event_timestamp: '2026-11-24T16:49:50Z', ...data }, ...o });

describe('analyserMessageRecu', () => {
  it('une vraie réponse humaine rattachée passe, adresse et Message-ID normalisés', () => {
    expect(analyserMessageRecu(ev())).toEqual({ statut: 'reponse', reponse: { workspaceId: 'ws1', evenementId: 'liv-1', matchType: 'message_id', contactEmail: 'contact@exemple.test', objet: 'Re: secret', messageId: 'm-1', rfcMessageId: 'abc@mail.test', email: 'contact@exemple.test', threadId: 't_1', survenuLe: '2026-11-24T16:49:50Z', nom: null } });
    expect(analyserMessageRecu(ev({ match_type: 'subject' })).statut).toBe('reponse');
  });
  it('jamais le corps dans ce qui est retenu ; l\'objet seulement, tronqué à 200 (relayé au CRM, CRM 27/11, comme dans les lots §5.25)', () => {
    const s = JSON.stringify(analyserMessageRecu(ev({ body: 'corps confidentiel' })));
    expect(s).not.toContain('confidentiel');
    const long = analyserMessageRecu(ev({ subject: 'x'.repeat(500) })) as { reponse: { objet: string } };
    expect(long.reponse.objet.length).toBe(200);
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
    expect(analyserMessageRecu(ev({ email: 'pas une adresse', from: 'pas non plus' }))).toEqual({ statut: 'ignore', raison: 'email_invalide' });
    // Contact illisible, expéditeur valable : la réponse passe, sans contact rattaché.
    expect((analyserMessageRecu(ev({ email: 'pas une adresse' })) as { reponse: { email: string; contactEmail: null } }).reponse).toMatchObject({ email: 'contact@exemple.test', contactEmail: null });
  });
});

describe('nomAffiche', () => {
  it('garde un nom propre, retire contrôles et chevrons, refuse une adresse ou un vide ; relayé depuis from_name', () => {
    expect([nomAffiche('  Alice\u0000  Martin '), nomAffiche('"Bob" <bob@x.fr>'), nomAffiche('bob@x.fr'), nomAffiche('   '), nomAffiche(null), nomAffiche('x'.repeat(300))?.length]).toEqual(['Alice Martin', null, null, null, null, 200]);
    const r = analyserMessageRecu({ id: 'l', type: 'message.received', workspace_id: 'w', data: { message_id: 'm', kind: 'reply_human', match_type: 'message_id', email: 'a@b.fr', from_name: 'Alice Martin' } });
    expect(r.statut === 'reponse' && r.reponse.nom).toBe('Alice Martin');
  });
  it('l\'identité est l\'expéditeur (data.from), pas le contact rattaché (data.email) : une collègue qui répond depuis une autre adresse (27/11)', () => {
    const a = analyserMessageRecu(ev({ from: 'Camille@Autre.Test' } as never)) as { reponse: { email: string; contactEmail: string } };
    expect([a.reponse.email, a.reponse.contactEmail]).toEqual(['camille@autre.test', 'contact@exemple.test']);
  });
});

describe('normaliserRfc', () => {
  it('la même clé dans les deux canaux, avec ou sans chevrons, casse et espaces (CRM, 27/11 : sinon deux lignes)', () => {
    expect([normaliserRfc(' <ABC@Mail.Test> '), normaliserRfc('abc@mail.test'), normaliserRfc('<>'), normaliserRfc(null)]).toEqual(['abc@mail.test', 'abc@mail.test', null, null]);
    expect((analyserMessageRecu({ id: 'liv-9', type: 'message.received', workspace_id: 'ws1', data: { message_id: 'm', rfc_message_id: '<ABC@Mail.Test>', kind: 'reply_human', match_type: 'message_id', email: 'c@x.test' } }) as { reponse: { rfcMessageId: string } }).reponse.rfcMessageId).toBe('abc@mail.test');
  });
});
