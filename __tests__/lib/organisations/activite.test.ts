// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activite, activiteOuverte } from '@/lib/organisations/activite';

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const MAINTENANT = Date.parse('2026-11-25T12:00:00Z');
const tenant = vi.fn();
const membres = vi.fn();
const agregat = vi.fn();
const db = { tenant: { findFirst: tenant }, tenantMember: { count: membres }, auditLog: { aggregate: agregat } } as never;
const lire = (depuis = '2026-11-25T00:00:00Z') => activite(db, { hub_tenant_id: T, hub_user_id: U, prefixe: 'twenty.create_', depuis }, MAINTENANT);
beforeEach(() => {
  vi.clearAllMocks();
  tenant.mockResolvedValue({ userId: 'autre' });
  membres.mockResolvedValue(1);
  agregat.mockResolvedValue({ _count: 2, _min: { createdAt: new Date('2026-11-25T01:00:00Z') }, _max: { createdAt: new Date('2026-11-25T02:00:00Z') } });
});

describe('activite', () => {
  it('compte les appels réussis de CE membre, dans CETTE organisation, avec CE préfixe, depuis CETTE date', async () => {
    expect(await lire()).toEqual({ fait: true, premier: '2026-11-25T01:00:00.000Z', dernier: '2026-11-25T02:00:00.000Z', nombre: 2 });
    expect(agregat.mock.calls[0][0].where).toEqual({
      action: 'mcp.tool.call', targetId: U, createdAt: { gte: new Date('2026-11-25T00:00:00Z') },
      AND: [{ payload: { path: ['espace'], equals: T } }, { payload: { path: ['ok'], equals: true } }, { payload: { path: ['outil'], string_starts_with: 'twenty.create_' } }],
    });
  });
  it('rien : fait faux, sans date inventée', async () => {
    agregat.mockResolvedValue({ _count: 0, _min: { createdAt: null }, _max: { createdAt: null } });
    expect(await lire()).toEqual({ fait: false, premier: null, dernier: null, nombre: 0 });
  });
  it('propriétaire accepté ; étranger ou retiré refusé, rien n\'est lu', async () => {
    membres.mockResolvedValue(0);
    expect(await lire()).toEqual({ refus: 'membre_introuvable' });
    expect(membres).toHaveBeenCalledWith({ where: { tenantId: T, userId: U, deletedAt: null } });
    expect(agregat).not.toHaveBeenCalled();
    tenant.mockResolvedValue({ userId: U });
    expect(await lire()).toMatchObject({ fait: true });
    tenant.mockResolvedValue(null);
    expect(await lire()).toEqual({ refus: 'organisation_introuvable' });
  });
  it('une date future ou trop ancienne est refusée', async () => {
    expect(await lire('2026-11-26T00:00:00Z')).toEqual({ refus: 'depuis_invalide' });
    expect(await lire('2025-01-01T00:00:00Z')).toEqual({ refus: 'depuis_invalide' });
  });
});

it('activiteOuverte : nommée seulement, jamais par défaut ni « tous »', () => {
  const o = (v?: string) => activiteOuverte(T, { NODE_ENV: 'test', ACTIVITE_ORGANISATIONS: v });
  expect([o(), o(''), o('tous'), o(`x, ${T}`), o(T + 'x')]).toEqual([false, false, false, true, false]);
});
