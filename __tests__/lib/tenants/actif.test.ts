// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ espaces: vi.fn() }));
vi.mock('@/lib/mcp/catalogue', () => ({ espacesDe: () => m.espaces() }));

import { COOKIE_ACTIF, organisationActive } from '@/lib/tenants/actif';

const active = (souhait?: string) => organisationActive({} as never, 'u', { par: 'session' }, souhait);
beforeEach(() => m.espaces.mockResolvedValue([{ id: 'A' }, { id: 'B' }]));

describe('organisationActive', () => {
  it('le souhait, seulement s\'il est membre d\'une organisation vivante', async () => {
    expect([await active('B'), await active('pas-a-moi'), await active()]).toEqual(['B', null, null]);
  });
  it('une seule : c\'est elle, même avec un souhait périmé ; aucune : rien', async () => {
    m.espaces.mockResolvedValue([{ id: 'A' }]);
    expect([await active(), await active('ancienne')]).toEqual(['A', 'A']);
    m.espaces.mockResolvedValue([]);
    expect(await active('A')).toBeNull();
  });
});
it('COOKIE_ACTIF : un nom stable, lu par le rebond', () => expect(COOKIE_ACTIF).toBe('veridian_org'));
