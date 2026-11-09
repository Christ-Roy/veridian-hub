/**
 * Notifuse relie son espace au tenant Hub (claim `tenant_id` du JWT MCP) : l'id Hub part à la création
 * de l'espace et à chaque update-plan (docs/CONTRAT-MCP.md).
 */
import { describe, expect, it, vi } from 'vitest';

import { NotifuseClient } from '@/lib/notifuse/client';

function client() {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ workspace_id: 'ws', api_key: 'k', created: true }), { status: 200 }));
  return { c: new NotifuseClient({ apiUrl: 'https://notifuse.test', hubSecret: 's', fetchImpl: fetchImpl as never }), fetchImpl };
}
const corps = (f: ReturnType<typeof vi.fn>) => JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));

describe('NotifuseClient : hub_tenant_id', () => {
  it('provision : à la racine et dans metadata', async () => {
    const { c, fetchImpl } = client();
    await c.provisionWorkspace({ tenantId: 'ws', ownerEmail: 'a@b.c', hubUserId: 'u1', hubTenantId: 't1' });
    expect(corps(fetchImpl)).toMatchObject({ hub_tenant_id: 't1', metadata: { hub_user_id: 'u1', hub_tenant_id: 't1' } });
  });
  it('update-plan : présent quand connu, absent sinon', async () => {
    const a = client();
    await a.c.updatePlan({ tenantId: 'ws', plan: 'pro', hubTenantId: 't1' });
    expect(corps(a.fetchImpl)).toMatchObject({ tenant_id: 'ws', plan: 'pro', hub_tenant_id: 't1' });
    const b = client();
    await b.c.updatePlan({ tenantId: 'ws', plan: 'pro' });
    expect(corps(b.fetchImpl)).not.toHaveProperty('hub_tenant_id');
  });
});
