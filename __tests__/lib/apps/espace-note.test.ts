// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { idEspaceMeta } from '@/lib/apps/espace-note';

// 26/11 (Analytics) : `hub link` écrivait external_tenant_id sans workspace_id ; le Hub voyait l'organisation « sans espace ».
describe('idEspaceMeta : une seule lecture de l\'espace noté', () => {
  it('workspace_id d\'abord, external_tenant_id à défaut, rien sinon', () => {
    expect(idEspaceMeta({ analytics: { workspace_id: 'w1', external_tenant_id: 'x1' } }, 'analytics')).toBe('w1');
    expect(idEspaceMeta({ analytics: { external_tenant_id: 'x1' } }, 'analytics')).toBe('x1');
    expect(idEspaceMeta({ analytics: { workspace_id: '', external_tenant_id: 'x1' } }, 'analytics')).toBe('x1');
    expect(idEspaceMeta({ analytics: {} }, 'analytics')).toBeNull();
    expect(idEspaceMeta({ crm: { workspace_id: 'c' } }, 'analytics')).toBeNull();
    expect(idEspaceMeta(null, 'analytics')).toBeNull();
    expect(idEspaceMeta({ analytics: { external_tenant_id: 42 } }, 'analytics')).toBeNull();
  });
});
