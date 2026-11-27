import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HORS_PERIMETRE, auditIdentity, compareIdentities, identityCounts, horsPerimetre } from '@/lib/sync/identity-audit';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

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

  it('nom vide chez l\'app face à un nom au Hub : écart ; clé absente : rien ; nom vide au Hub : compté à part (27/11)', () => {
    const hub = [{ supabaseUserId: 'id-1', email: 'a@x.fr', name: 'Robert Brunon', emailVerified: new Date() }, { supabaseUserId: 'id-2', email: 'b@x.fr', name: '  ', emailVerified: new Date() }];
    const r = compareIdentities([{ hub_user_id: 'id-1', email: 'a@x.fr', name: null }, { hub_user_id: 'id-2', email: 'b@x.fr', name: 'B' }], hub as never);
    expect(r.nameMismatch).toEqual(['a@x.fr']);
    expect(r.nomVideAuHub).toEqual(['b@x.fr']);
    expect(compareIdentities([{ hub_user_id: 'id-1', email: 'a@x.fr' }], hub as never).nameMismatch).toEqual([]);
    expect(compareIdentities([{ hub_user_id: 'id-1', email: 'a@x.fr', name: 'Robert Brunon' }], hub as never).nameMismatch).toEqual([]);
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

describe('horsPerimetre', () => {
  it('un compte interne est nommé avec sa raison ; un client, ou la même adresse dans une autre app, jamais', () => {
    expect(horsPerimetre('notifuse', 'robert@veridian.site')).toContain('opérateur');
    expect(horsPerimetre('crm', 'robert@veridian.site')).toBeNull();
    expect(horsPerimetre('notifuse', 'robert@client.fr')).toBeNull();
  });
});

describe('auditIdentity, version de signature', () => {
  const prisma = { user: { findMany: vi.fn(async () => HUB) } };
  const lire = async () => {
    vi.stubEnv('NOTIFUSE_API_URL', 'https://n.test');
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 'secret');
    let vu: { url: string; h: Record<string, string> } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      vu = { url, h: init?.headers as Record<string, string> };
      return Response.json({ users: [] });
    }) as unknown as typeof fetch;
    await auditIdentity(prisma as never, { apps: ['notifuse'], fetchImpl });
    return vu as unknown as { url: string; h: Record<string, string> };
  };
  afterEach(() => vi.unstubAllEnvs());
  it('HMAC_V2_APPS=notifuse : le GET de la liste des comptes part en v2', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const v = await lire();
    exigeV2(v.h, 'secret', 'GET', v.url);
  });
  it('variable absente : v1', async () => {
    const v = await lire();
    exigeV1(v.h, 'secret');
  });
});
