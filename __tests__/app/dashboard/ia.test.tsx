// @vitest-environment node
/** Page Assistants IA : le connecteur d'abord. Une clé d'API n'est offerte que pour la fenêtre du CRM, repliée (Robert, 25/11). */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ branchements: vi.fn(), ouvertes: vi.fn(), tenants: vi.fn(), apps: vi.fn() }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'i' } }) }));
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock('@/lib/ia/atelier', () => ({ FOURNISSEUR_ABONNEMENT: 'claude-abonnement', atelierConfigure: () => null, tenantOuvertDuCompte: async () => null }));
vi.mock('@/lib/ia/branchements', () => ({ branchementsDe: () => m.branchements() }));
vi.mock('@/lib/mcp/catalogue', () => ({ espacesDe: async () => [{ id: 'A', nom: 'Atelier' }], appsDe: () => m.apps() }));
vi.mock('@/lib/mcp/connexions', () => ({ connexionsActives: async () => [] }));
vi.mock('@/lib/tenant-apps', () => ({ getEnabledGatedApps: () => m.ouvertes() }));
vi.mock('@/app/dashboard/ia/connexions-ia-actions', () => ({ couperConnexionIa: async () => {} }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: async () => ({ supabaseUserId: 'u' }) }, iaActivation: { findMany: async () => [] }, tenant: { findMany: () => m.tenants() } } }));

import Page from '@/app/dashboard/ia/page';
import { MonIa } from '@/app/dashboard/ia/MonIa';

const html = async () => renderToStaticMarkup(await Page());
const CLE = { fournisseur: 'anthropic', modele: 'm', cleFin: 'abcd' };
beforeEach(() => {
  m.branchements.mockResolvedValue([]);
  m.ouvertes.mockResolvedValue(new Set());
  m.tenants.mockResolvedValue([{ id: 'A', metadata: { crm: { workspace_id: 'w' } } }]);
  m.apps.mockResolvedValue([{ appKey: 'notifuse', label: 'Mail' }, { appKey: 'prospection', label: 'Atlas' }]);
});

describe('/dashboard/ia', () => {
  it('le connecteur d\'abord, avec les apps que l\'IA atteint', async () => {
    const h = await html();
    expect(h).toContain('Ajouter à Claude');
    expect(h.indexOf('Ajouter à Claude')).toBeLessThan(h.indexOf('Assistants connectés'));
    for (const a of ['Mail', 'Atlas']) expect(h).toContain(`>${a}</li>`);
  });
  it('sans CRM, aucune clé proposée, Academy comprise', async () => {
    expect(await html()).not.toContain('type="password"');
    m.ouvertes.mockResolvedValue(new Set(['academy']));
    const h = await html();
    expect([h.includes('type="password"'), h.includes('Avancé'), h.includes('clé d')]).toEqual([false, false, false]);
  });
  it('avec le CRM : repliée, facultative, après le connecteur', async () => {
    m.ouvertes.mockResolvedValue(new Set(['twenty']));
    const h = await html();
    expect(h).toContain('<details');
    expect(h).not.toContain('<details open');
    expect(h.indexOf('Ajouter à Claude')).toBeLessThan(h.indexOf('type="password"'));
    expect(h.slice(h.indexOf('<details'), h.indexOf('type="password"'))).toContain('Facultatif');
  });
  it('une clé déjà branchée reste visible et débranchable', async () => {
    m.ouvertes.mockResolvedValue(new Set(['twenty']));
    m.branchements.mockResolvedValue([CLE]);
    const h = await html();
    for (const t of ['clé terminant par abcd', 'Débrancher', 'Allumé']) expect(h).toContain(t);
    m.ouvertes.mockResolvedValue(new Set());
    expect(await html()).toContain('Débrancher');
  });
});

it('MonIa : plus jamais « coupé par défaut », la clé repliée', () => {
  const h = renderToStaticMarkup(<MonIa branchements={[]} espaces={[]} activations={[]} apps={[]} />);
  expect(h).not.toContain('Coupé par défaut');
  expect(h.indexOf('<details')).toBeLessThan(h.indexOf('type="password"'));
});
