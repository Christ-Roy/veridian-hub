// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rejoindre: vi.fn(), suivre: vi.fn() }));
vi.mock('@/lib/tenants/membres', async (orig) => ({ ...(await orig<typeof import('@/lib/tenants/membres')>()), rejoindre: m.rejoindre }));
vi.mock('@/lib/organisations/emission', () => ({ suivreOrganisation: m.suivre }));

import { RefusMembre } from '@/lib/tenants/membres';
import { importerMembres, normaliser } from '@/lib/organisations/importer';

type L = Record<string, any>;
let users: L[];
let membres: L[];
// Lecture seule : aucune méthode d'écriture n'existe sur ces tables, toute écriture directe ferait échouer le test.
const db = {
  tenant: { findFirst: async ({ where }: L) => (where.id === 'T' ? { id: 'T', userId: 'prop' } : null) },
  user: { findFirst: async ({ where }: L) => users.find((u) => u.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null },
  tenantMember: { findUnique: async ({ where }: L) => membres.find((x) => x.userId === where.tenantId_userId.userId) ?? null },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.suivre.mockResolvedValue([{ app: 'academy', version: 1, etat: 'applique' }]);
  m.rejoindre.mockResolvedValue({ cree: true, role: 'member' });
  users = [
    { supabaseUserId: 'prop', email: 'prop@x.fr', emailVerified: new Date() },
    { supabaseUserId: 'nouveau', email: 'nouveau@x.fr', emailVerified: new Date() },
    { supabaseUserId: 'actif', email: 'actif@x.fr', emailVerified: new Date() },
    { supabaseUserId: 'parti', email: 'parti@x.fr', emailVerified: new Date() },
    { supabaseUserId: 'flou', email: 'flou@x.fr', emailVerified: null },
  ];
  membres = [{ userId: 'actif', role: 'admin', deletedAt: null }, { userId: 'parti', role: 'member', deletedAt: new Date() }];
});

const etat = (r: Awaited<ReturnType<typeof importerMembres>>, email: string) => ('lignes' in r ? r.lignes.find((l) => l.email === email) : undefined);

describe('normaliser', () => {
  it('minuscules, sans doublon (le premier gagne), rôle par défaut member', () => {
    expect(normaliser([{ email: ' A@X.fr ' }, { email: 'a@x.fr', role: 'admin' }, { email: 'b@x.fr', role: '' }])).toEqual([
      { email: 'a@x.fr', role: 'member' },
      { email: 'b@x.fr', role: 'member' },
    ]);
  });
});

describe('importerMembres', () => {
  it('chaque adresse rend son état ; seul le nouveau membre passe par rejoindre, en opérateur', async () => {
    const r = await importerMembres(db, { tenantId: 'T', acteur: 'op', membres: [
      { email: 'nouveau@x.fr' }, { email: 'inconnu@x.fr' }, { email: 'flou@x.fr' }, { email: 'actif@x.fr', role: 'member' }, { email: 'parti@x.fr' }, { email: 'prop@x.fr' },
    ] });
    expect('lignes' in r && r.lignes.map((l) => l.etat)).toEqual(['joint', 'compte_absent', 'adresse_non_prouvee', 'deja', 'retire', 'deja']);
    expect(m.rejoindre).toHaveBeenCalledTimes(1);
    expect(m.rejoindre.mock.calls[0][1]).toMatchObject({ tenantId: 'T', hubUserId: 'nouveau', role: 'member', origine: 'operateur', acteur: 'op' });
    expect(etat(r, 'actif@x.fr')).toMatchObject({ role: 'admin', detail: 'rôle admin conservé' });
  });
  it('à blanc : dit ce qui se passerait, n\'écrit rien et n\'émet rien', async () => {
    const r = await importerMembres(db, { tenantId: 'T', acteur: 'op', aBlanc: true, membres: [{ email: 'nouveau@x.fr' }, { email: 'parti@x.fr' }, { email: 'flou@x.fr' }] });
    expect('lignes' in r && r.lignes.map((l) => [l.etat, l.detail])).toEqual([['joint', 'à blanc'], ['retire', undefined], ['adresse_non_prouvee', undefined]]);
    expect(m.rejoindre).not.toHaveBeenCalled();
    expect(m.suivre).not.toHaveBeenCalled();
  });
  it('un retiré n\'est jamais rejoint, même si rejoindre accepterait', async () => {
    await importerMembres(db, { tenantId: 'T', acteur: 'op', membres: [{ email: 'parti@x.fr' }] });
    expect(m.rejoindre).not.toHaveBeenCalled();
  });
  it('un rôle hors member/admin, un owner, une adresse mal formée : refusés sans appel', async () => {
    const r = await importerMembres(db, { tenantId: 'T', acteur: 'op', membres: [{ email: 'nouveau@x.fr', role: 'owner' }, { email: 'pas-une-adresse' }] });
    expect('lignes' in r && r.lignes).toEqual([
      expect.objectContaining({ etat: 'refuse', detail: 'role_refuse' }),
      expect.objectContaining({ etat: 'refuse', detail: 'adresse_invalide' }),
    ]);
    expect(m.rejoindre).not.toHaveBeenCalled();
  });
  it('un refus de rejoindre (tenant suspendu) est dit, les autres lignes passent quand même', async () => {
    m.rejoindre.mockRejectedValueOnce(new RefusMembre('tenant_suspendu')).mockResolvedValueOnce({ cree: true, role: 'member' });
    users.push({ supabaseUserId: 'deux', email: 'deux@x.fr', emailVerified: new Date() });
    const r = await importerMembres(db, { tenantId: 'T', acteur: 'op', membres: [{ email: 'nouveau@x.fr' }, { email: 'deux@x.fr' }] });
    expect('lignes' in r && r.lignes.map((l) => [l.etat, l.detail])).toEqual([['refuse', 'tenant_suspendu'], ['joint', undefined]]);
  });
  it('une seule émission après l\'import, quel que soit le nombre de lignes', async () => {
    await importerMembres(db, { tenantId: 'T', acteur: 'op', membres: [{ email: 'nouveau@x.fr' }, { email: 'actif@x.fr' }] });
    expect(m.suivre).toHaveBeenCalledTimes(1);
  });
  it('tenant inconnu : rien n\'est lu au-delà, rien n\'est émis', async () => {
    expect(await importerMembres(db, { tenantId: 'X', acteur: 'op', membres: [{ email: 'nouveau@x.fr' }] })).toEqual({ refus: 'tenant_introuvable' });
    expect(m.suivre).not.toHaveBeenCalled();
  });
});
