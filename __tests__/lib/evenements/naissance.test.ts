// @vitest-environment node
/** L'abonnement d'une organisation neuve : seulement elle, une fois, sans jamais faire échouer l'ouverture d'une app. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ suivre: vi.fn() }));
vi.mock('@/lib/evenements/allumage', () => ({ suivreAbonnement: (...a: unknown[]) => m.suivre(...a) }));

import { NEUVE_DEPUIS } from '@/lib/delegation/etat';
import { abonnerParDefaut } from '@/lib/evenements/naissance';

const ENV = { NODE_ENV: 'test', DELEGATION_EVENEMENTS: 'notifuse>crm' } as NodeJS.ProcessEnv;
let t: any;
let paire: any;
let abonnee: boolean;
const db = { tenant: { findFirst: async () => t }, organisation: { findUnique: async () => null }, integrationPaire: { findUnique: async () => paire }, evenementAbonnement: { findFirst: async () => (abonnee ? { tenantId: 'T' } : null) } } as never;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  m.suivre.mockResolvedValue('fait');
  t = { notifuseWorkspaceSlug: 'w', prospectionProvisionedAt: null, metadata: { crm: { workspace_id: 'c' } }, createdAt: NEUVE_DEPUIS };
  paire = null;
  abonnee = false;
});
describe('abonnerParDefaut', () => {
  it('neuve, Mail et CRM ouverts : abonnée', async () => {
    expect(await abonnerParDefaut(db, 'T', ENV)).toBe('fait');
    expect(m.suivre.mock.calls[0][1]).toEqual({ tenantId: 'T', paire: 'notifuse>crm', actif: true });
  });
  it.each([
    ['existante', () => { t.createdAt = new Date('2026-06-01'); }],
    ['CRM pas ouvert', () => { t.metadata = {}; }],
    ['Mail pas ouvert', () => { t.notifuseWorkspaceSlug = null; }],
    ['coupée', () => { paire = { etat: 'eteinte', consentiLe: null, portees: null }; }],
    ['déjà abonnée', () => { abonnee = true; }],
  ])('%s : rien', async (_n, casser) => {
    casser();
    expect([await abonnerParDefaut(db, 'T', ENV), m.suivre.mock.calls.length]).toEqual(['sans_objet', 0]);
  });
  it('événements fermés : rien', async () => expect([await abonnerParDefaut(db, 'T', { NODE_ENV: 'test' }), m.suivre.mock.calls.length]).toEqual(['sans_objet', 0]));
  it('Mail muet, base en panne : dit, jamais levé', async () => {
    m.suivre.mockResolvedValue('echec');
    expect(await abonnerParDefaut(db, 'T', ENV)).toBe('echec');
    expect(await abonnerParDefaut({ integrationPaire: { findUnique: async () => { throw new Error('base'); } }, tenant: { findFirst: async () => null } } as never, 'T', ENV)).toBe('echec');
  });
});
