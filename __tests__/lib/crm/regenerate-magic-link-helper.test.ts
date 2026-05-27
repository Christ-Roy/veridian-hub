/**
 * Tests pour le helper module-level lib/crm/client.regenerateMagicLink(id).
 *
 * Distinct de CrmClient.regenerateMagicLink (méthode bas-niveau) — cette
 * fonction est consommée par la route user dashboard
 * `/api/dashboard/crm/regenerate-magic-link` qui n'a que l'id du tenant.
 *
 * Couvre :
 *  - lookup OK → decrypt password → délègue à CrmClient via fetch GraphQL
 *  - throw Error si tenant inexistant / deleted / suspended
 *  - n'expose JAMAIS le password dans le message d'erreur (smoke check)
 *
 * Stratégie de mock : on stub @/lib/crm/select-tenant + @/lib/crm/vault
 * et on intercepte globalThis.fetch (utilisé par CrmClient via le default
 * fetchImpl). Les ENV CRM_* sont posées pour que createCrmClientFromEnv()
 * passe.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const { getCrmTenantByIdMock, decryptSecretMock } = vi.hoisted(() => ({
  getCrmTenantByIdMock: vi.fn(),
  decryptSecretMock: vi.fn(),
}));

vi.mock('@/lib/crm/select-tenant', () => ({
  getCrmTenantById: (...args: unknown[]) => getCrmTenantByIdMock(...args),
}));

vi.mock('@/lib/crm/vault', () => ({
  decryptSecret: (...args: unknown[]) => decryptSecretMock(...args),
}));

import { regenerateMagicLink } from '@/lib/crm/client';

const ORIG_ENV = {
  CRM_METADATA_URL: process.env.CRM_METADATA_URL,
  CRM_REST_URL: process.env.CRM_REST_URL,
  CRM_FRONTEND_URL: process.env.CRM_FRONTEND_URL,
};

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const activeTenant = {
  id: 'tenant-uuid',
  email: 'client@example.com',
  twentyWorkspaceUrl: 'https://acme.crm/',
  twentyPasswordEncrypted: 'enc(stored-password)',
  status: 'active',
};

beforeAll(() => {
  process.env.CRM_METADATA_URL = 'https://crm.test/metadata';
  process.env.CRM_REST_URL = 'https://crm.test/rest';
  process.env.CRM_FRONTEND_URL = 'https://crm.test';
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  getCrmTenantByIdMock.mockReset();
  decryptSecretMock.mockReset();
  decryptSecretMock.mockImplementation((c: string) =>
    c.replace(/^enc\(/, '').replace(/\)$/, ''),
  );
  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: {
          getLoginTokenFromCredentials: {
            loginToken: {
              token: 'regen-token',
              expiresAt: '2026-05-27T13:00:00.000Z',
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  globalThis.fetch = fetchMock as never;
});

describe('lib/crm/client — regenerateMagicLink(crmTenantId) helper', () => {
  it('happy path : lookup + decrypt + délègue à CrmClient.regenerateMagicLink', async () => {
    getCrmTenantByIdMock.mockResolvedValueOnce(activeTenant);

    const result = await regenerateMagicLink('tenant-uuid');

    expect(result.magicLinkUrl).toBe('https://acme.crm/verify?loginToken=regen-token');
    expect(decryptSecretMock).toHaveBeenCalledWith('enc(stored-password)');
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.variables.email).toBe('client@example.com');
    expect(body.variables.password).toBe('stored-password');
    expect(body.variables.origin).toBe('https://acme.crm/');
  });

  it('throws if tenant not found', async () => {
    getCrmTenantByIdMock.mockResolvedValueOnce(null);
    await expect(regenerateMagicLink('missing')).rejects.toThrow(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws if tenant is deleted', async () => {
    getCrmTenantByIdMock.mockResolvedValueOnce({ ...activeTenant, status: 'deleted' });
    await expect(regenerateMagicLink('tenant-uuid')).rejects.toThrow(/deleted/);
    expect(decryptSecretMock).not.toHaveBeenCalled();
  });

  it('throws if tenant is suspended (not active)', async () => {
    getCrmTenantByIdMock.mockResolvedValueOnce({ ...activeTenant, status: 'suspended' });
    await expect(regenerateMagicLink('tenant-uuid')).rejects.toThrow(/not active/);
  });

  it('error messages never leak the decrypted password', async () => {
    getCrmTenantByIdMock.mockResolvedValueOnce(activeTenant);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'upstream rejected' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      await regenerateMagicLink('tenant-uuid');
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain('stored-password');
    }
  });
});
