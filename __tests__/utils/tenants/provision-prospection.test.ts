/**
 * Test que provisionProspectionTenant envoie user_id + metadata.hub_user_id
 * dans le body, comme attendu par le contrat Hub v1.2 §5.1 (cf
 * todo/2026-05-19-prospection-provision-user-id.md).
 *
 * Sans ces champs, Prospection skip le setup workspace côté app et le client
 * provisionné via Hub ne peut pas se connecter (pas de membership admin).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'tenant-1' })),
      update: vi.fn(async () => ({ id: 'tenant-1' })),
    },
    provisioningLog: {
      create: vi.fn(async () => ({})),
    },
  },
}));

vi.mock('@/utils/tenants/debug', () => ({
  logProvisionStart: vi.fn(),
  logProvisionEnd: vi.fn(),
  logStep: vi.fn(),
  logError: vi.fn(),
}));

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

beforeEach(() => {
  fetchMock.mockReset();
  process.env.PROSPECTION_API_URL = 'https://prospection.test';
  process.env.PROSPECTION_TENANT_API_SECRET = 'test-secret';
});

describe('provisionProspectionTenant', () => {
  it('envoie user_id + metadata.hub_user_id + HMAC headers standard', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          tenant_id: 't-remote-1',
          api_key: 'key-1',
          login_url: 'https://prospection.test/login?t=abc',
          created: true,
        }),
    });

    const { provisionProspectionTenant } = await import(
      '@/utils/tenants/provision'
    );
    await provisionProspectionTenant('alice@veridian.test', 'uuid-alice');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://prospection.test/api/tenants/provision');

    const body = JSON.parse(init.body);
    expect(body.user_id).toBe('uuid-alice');
    expect(body.metadata).toEqual({ hub_user_id: 'uuid-alice' });
    expect(body.email).toBe('alice@veridian.test');
    expect(body.plan).toBe('freemium');
    expect(body.name).toBe('alice');

    // HMAC standard headers — pas de Bearer ni d'ancien `signature` dans body
    expect(init.headers['X-Veridian-Timestamp']).toMatch(/^\d+$/);
    expect(init.headers['X-Veridian-Hub-Signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(init.headers.Authorization).toBeUndefined();
    expect(body.signature).toBeUndefined();
    expect(body.timestamp).toBeUndefined();
  });

  it('fonctionne avec PROSPECTION_HUB_API_SECRET seul (sans legacy)', async () => {
    delete process.env.PROSPECTION_TENANT_API_SECRET;
    process.env.PROSPECTION_HUB_API_SECRET = 'new-secret-cible';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          tenant_id: 't-1',
          api_key: 'k',
          login_url: 'https://x/?t=y',
        }),
    });

    const { provisionProspectionTenant } = await import(
      '@/utils/tenants/provision'
    );
    const result = await provisionProspectionTenant('b@c.d', 'uuid-2');
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retourne success false si PROSPECTION_API_URL absent', async () => {
    delete process.env.PROSPECTION_API_URL;
    const { provisionProspectionTenant } = await import(
      '@/utils/tenants/provision'
    );
    const result = await provisionProspectionTenant('a@b.c', 'uuid-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
