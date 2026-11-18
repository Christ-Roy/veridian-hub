import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HORS_PERIMETRE, auditIdentity, compareIdentities, identityCounts } from '@/lib/sync/identity-audit';

const HUB = [{ supabaseUserId: 'id-1', email: 'a@x.fr', name: 'Alice' }];

describe('compareIdentities', () => {
  it('classe chaque compte local', () => {
    const r = compareIdentities(
      [
        { hub_user_id: 'id-1', email: 'A@x.fr', name: 'Alice' },
        { hub_user_id: null, email: 'seul@x.fr', name: null },
        { hub_user_id: 'id-inconnu', email: 'perdu@x.fr', name: null },
        { hub_user_id: null, email: 'a@x.fr', name: null },
      ],
      HUB,
    );
    expect(r.localAccounts).toBe(4);
    expect(r.withoutHub).toEqual(['seul@x.fr', 'perdu@x.fr']);
    // HUB ne porte pas emailVerified : on ne présume pas la preuve, le compte attend sa preuve.
    expect(r.unlinked).toEqual([]);
    expect(r.awaitingProof).toEqual(['a@x.fr']);
    expect(r.emailMismatch).toEqual([]);
  });

  it('adresse prouvée au Hub : reliée au prochain rebond ; non prouvée : en attente de preuve', () => {
    const hub = [
      { supabaseUserId: 'p', email: 'prouve@x.fr', name: null, emailVerified: new Date() },
      { supabaseUserId: 'n', email: 'nonprouve@x.fr', name: null, emailVerified: null },
    ];
    const r = compareIdentities(
      [
        { hub_user_id: null, email: 'prouve@x.fr' },
        { hub_user_id: null, email: 'nonprouve@x.fr' },
      ],
      hub,
    );
    expect(r.unlinked).toEqual(['prouve@x.fr']);
    expect(r.awaitingProof).toEqual(['nonprouve@x.fr']);
  });

  it('voit un écart d\'email et de nom sur un compte relié', () => {
    const r = compareIdentities([{ hub_user_id: 'id-1', email: 'ancien@x.fr', name: 'Al' }], HUB);
    expect(r.emailMismatch).toEqual(['ancien@x.fr']);
    expect(r.nameMismatch).toEqual(['ancien@x.fr']);
  });
});

describe('auditIdentity', () => {
  const prisma = { user: { findMany: vi.fn(async () => HUB) } };
  beforeEach(() => {
    vi.stubEnv('NOTIFUSE_API_URL', 'https://n.test');
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 'secret');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [404, 'endpoint_missing'],
    [500, 'unreachable'],
  ])('HTTP %i → %s, jamais un « aucun écart »', async (status, expected) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status }));
    const r = await auditIdentity(prisma as never, { apps: ['notifuse'], fetchImpl: fetchImpl as never });
    expect(r.notifuse?.status).toBe(expected);
  });

  it('un corps illisible n\'est pas un succès', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"oops":1}', { status: 200 }));
    const r = await auditIdentity(prisma as never, { apps: ['notifuse'], fetchImpl: fetchImpl as never });
    expect(r.notifuse?.status).toBe('unreachable');
  });

  it('ne publie aucune adresse dans la version pour les logs', () => {
    const counts = identityCounts({
      notifuse: compareIdentities([{ email: 'secret@x.fr' }], HUB),
    });
    expect(JSON.stringify(counts)).not.toContain('secret@x.fr');
    expect(counts?.notifuse).toMatchObject({ withoutHub: 1 });
  });
});

describe('hors périmètre (témoins et comptes d\'exploitation, tranchés le 09/11)', () => {
  it('canari Notifuse sans compte Hub : hors périmètre avec sa raison, pas withoutHub', () => {
    const a = compareIdentities([{ email: 'canarypro@veridian.site' }, { email: 'inconnu@client.fr' }], [], 'notifuse');
    expect(a.withoutHub).toEqual(['inconnu@client.fr']);
    expect(a.horsPerimetre).toEqual([expect.objectContaining({ email: 'canarypro@veridian.site' })]);
  });
  it('la liste est propre à chaque app : le même canari ailleurs reste un écart', () => {
    expect(compareIdentities([{ email: 'canarypro@veridian.site' }], [], 'analytics').withoutHub).toEqual(['canarypro@veridian.site']);
  });
  it('une adresse connue du Hub n\'est jamais mise hors périmètre', () => {
    const a = compareIdentities([{ email: 'admin@veridian.site' }], [{ supabaseUserId: 'u', email: 'admin@veridian.site', name: null, emailVerified: new Date() }], 'notifuse');
    expect(a.horsPerimetre).toEqual([]);
    expect(a.unlinked).toEqual(['admin@veridian.site']);
  });
  it('aucun motif ne peut attraper une adresse client : domaines internes seulement', () => {
    for (const entrees of Object.values(HORS_PERIMETRE)) {
      for (const { motif, raison } of entrees ?? []) {
        expect(motif.source, raison).toMatch(/veridian\\\.site|agences-veridian\\\.fr/);
        expect(raison.length).toBeGreaterThan(10);
      }
    }
  });
});
