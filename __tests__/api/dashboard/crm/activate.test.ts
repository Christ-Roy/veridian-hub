/**
 * Tests pour POST /api/dashboard/crm/activate.
 *
 * Endpoint user-side (session Hub requise) qui lazy-provision OU
 * régénère un magic-link CRM Twenty.
 *
 * Couvre :
 *  - 401 si pas de session user
 *  - 401 si session sans email
 *  - 200 idempotent quand CrmTenant active existe (regenerateMagicLink)
 *  - 502 si regenerateMagicLink throw (upstream Twenty down, password
 *    déchiffrement fail, etc.)
 *  - 200 nouveau tenant créé (createTenant) + Prisma create + chiffrement
 *    appliqué sur password ET API key
 *  - 502 si createTenant throw
 *  - Aucune fuite : la response ne contient JAMAIS le password ni l'API
 *    key Bearer en clair (sécurité critique — garde-fou explicite)
 *  - getCrmTenantByEmail fallback si getCrmTenantByUserId vide
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCurrentUserMock = vi.fn();
const getCrmTenantByUserIdMock = vi.fn();
const getCrmTenantByEmailMock = vi.fn();
const regenerateMagicLinkMock = vi.fn();
const createCrmClientFromEnvMock = vi.fn();
const createTenantMock = vi.fn();
const encryptSecretMock = vi.fn();
const prismaCrmTenantCreateMock = vi.fn();

vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
}));

vi.mock('@/lib/crm/select-tenant', () => ({
  getCrmTenantByUserId: (...args: unknown[]) => getCrmTenantByUserIdMock(...args),
  getCrmTenantByEmail: (...args: unknown[]) => getCrmTenantByEmailMock(...args),
}));

vi.mock('@/lib/crm/client', () => ({
  createCrmClientFromEnv: (...args: unknown[]) => createCrmClientFromEnvMock(...args),
  regenerateMagicLink: (...args: unknown[]) => regenerateMagicLinkMock(...args),
}));

vi.mock('@/lib/crm/vault', () => ({
  encryptSecret: (...args: unknown[]) => encryptSecretMock(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    crmTenant: {
      create: (...args: unknown[]) => prismaCrmTenantCreateMock(...args),
    },
  },
}));

// Import APRÈS les mocks pour qu'ils soient injectés.
const { POST } = await import('@/app/api/dashboard/crm/activate/route');

function makeRequest(): Request {
  return new Request('http://localhost/api/dashboard/crm/activate', {
    method: 'POST',
  });
}

const FAKE_USER = {
  id: 'user_id_123',
  email: 'alice@example.com',
  name: 'Alice Test',
};

const FAKE_CRM_TENANT_ACTIVE = {
  id: 'crm_tenant_uuid_active',
  status: 'active' as const,
  twentyWorkspaceUrl: 'https://veridian-test.crm.staging.veridian.site',
  email: 'alice@example.com',
};

const FAKE_CREATE_RESULT = {
  twentyWorkspaceId: 'twenty_ws_uuid',
  twentyWorkspaceUrl: 'https://veridian-new.crm.staging.veridian.site',
  twentyApiKeyId: 'twenty_api_key_uuid',
  twentyApiKeyToken: 'BEARER_TOKEN_VERY_LONG_JWT_TO_BE_ENCRYPTED',
  twentyApiKeyExpiresAt: new Date('2027-05-27T12:48:38.000Z'),
  passwordGenerated: 'PLAIN_PASSWORD_GENERATED_BY_CLIENT',
  initialMagicLinkUrl: 'https://veridian-new.crm.staging.veridian.site/verify?loginToken=NEW',
};

describe('POST /api/dashboard/crm/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // defaults — chaque test override ce qu'il faut
    encryptSecretMock.mockImplementation((plain: string) => `enc(${plain})`);
    createCrmClientFromEnvMock.mockReturnValue({
      createTenant: createTenantMock,
    });
  });

  it('retourne 401 si pas de session user', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('retourne 401 si session sans email', async () => {
    getCurrentUserMock.mockResolvedValueOnce({ id: 'user_x', email: null });
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('idempotent: si CrmTenant active existe, regenerateMagicLink + retourne magicLinkUrl', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce(FAKE_CRM_TENANT_ACTIVE);
    regenerateMagicLinkMock.mockResolvedValueOnce({
      magicLinkUrl: 'https://veridian-test.crm.staging.veridian.site/verify?loginToken=REGEN',
      expiresAt: new Date('2026-05-27T13:30:00.000Z'),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.magicLinkUrl).toContain('loginToken=REGEN');
    expect(body.crmTenantId).toBe(FAKE_CRM_TENANT_ACTIVE.id);
    expect(body.workspaceUrl).toBe(FAKE_CRM_TENANT_ACTIVE.twentyWorkspaceUrl);

    // PAS de re-provision (pas d'appel à createTenant)
    expect(createTenantMock).not.toHaveBeenCalled();
    expect(prismaCrmTenantCreateMock).not.toHaveBeenCalled();
  });

  it('fallback getCrmTenantByEmail si getCrmTenantByUserId vide', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce(null);
    getCrmTenantByEmailMock.mockResolvedValueOnce(FAKE_CRM_TENANT_ACTIVE);
    regenerateMagicLinkMock.mockResolvedValueOnce({
      magicLinkUrl: 'https://x.crm/verify?loginToken=Y',
      expiresAt: new Date(),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(getCrmTenantByEmailMock).toHaveBeenCalledWith(FAKE_USER.email);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
  });

  it('retourne 502 magic_link_failed si regenerateMagicLink throw', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce(FAKE_CRM_TENANT_ACTIVE);
    regenerateMagicLinkMock.mockRejectedValueOnce(
      new Error('upstream Twenty timeout'),
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('magic_link_failed');
    expect(body.message).toBeTruthy();
    expect(body.message).not.toContain('Twenty'); // pas de leak du upstream
  });

  it('nouveau tenant: créé via createTenant, chiffré, persisté, magicLinkUrl retourné', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce(null);
    getCrmTenantByEmailMock.mockResolvedValueOnce(null);
    createTenantMock.mockResolvedValueOnce(FAKE_CREATE_RESULT);
    prismaCrmTenantCreateMock.mockResolvedValueOnce({ id: 'new_crm_tenant_uuid' });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(false);
    expect(body.magicLinkUrl).toBe(FAKE_CREATE_RESULT.initialMagicLinkUrl);
    expect(body.crmTenantId).toBe('new_crm_tenant_uuid');
    expect(body.workspaceUrl).toBe(FAKE_CREATE_RESULT.twentyWorkspaceUrl);

    // Le client createTenant a été appelé avec email + workspaceName basé sur user
    expect(createTenantMock).toHaveBeenCalledWith({
      email: FAKE_USER.email,
      workspaceName: FAKE_USER.name,
    });

    // encryptSecret appelé pour PASSWORD + API key
    expect(encryptSecretMock).toHaveBeenCalledWith(FAKE_CREATE_RESULT.passwordGenerated);
    expect(encryptSecretMock).toHaveBeenCalledWith(FAKE_CREATE_RESULT.twentyApiKeyToken);

    // Prisma create appelé avec les valeurs CHIFFRÉES
    expect(prismaCrmTenantCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = prismaCrmTenantCreateMock.mock.calls[0][0];
    expect(createArgs.data.twentyPasswordEncrypted).toBe(`enc(${FAKE_CREATE_RESULT.passwordGenerated})`);
    expect(createArgs.data.twentyApiKeyEncrypted).toBe(`enc(${FAKE_CREATE_RESULT.twentyApiKeyToken})`);
    expect(createArgs.data.status).toBe('active');
    expect(createArgs.data.email).toBe(FAKE_USER.email);
    expect(createArgs.data.userId).toBe(FAKE_USER.id);
  });

  it('workspaceName fallback sur partie locale email si user.name vide', async () => {
    getCurrentUserMock.mockResolvedValueOnce({ ...FAKE_USER, name: null });
    getCrmTenantByUserIdMock.mockResolvedValueOnce(null);
    getCrmTenantByEmailMock.mockResolvedValueOnce(null);
    createTenantMock.mockResolvedValueOnce(FAKE_CREATE_RESULT);
    prismaCrmTenantCreateMock.mockResolvedValueOnce({ id: 'x' });

    await POST(makeRequest());

    expect(createTenantMock).toHaveBeenCalledWith({
      email: FAKE_USER.email,
      workspaceName: 'alice', // = partie locale de alice@example.com
    });
  });

  it('retourne 502 crm_provision_failed si createTenant throw', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce(null);
    getCrmTenantByEmailMock.mockResolvedValueOnce(null);
    createTenantMock.mockRejectedValueOnce(new Error('Twenty signUpInWorkspace failed'));

    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('crm_provision_failed');
  });

  it('CRITIQUE SÉCU : la response ne contient JAMAIS le password ni le Bearer en clair', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce(null);
    getCrmTenantByEmailMock.mockResolvedValueOnce(null);
    createTenantMock.mockResolvedValueOnce(FAKE_CREATE_RESULT);
    prismaCrmTenantCreateMock.mockResolvedValueOnce({ id: 'x' });

    const res = await POST(makeRequest());
    const bodyText = await res.text();

    // Le password généré et le Bearer NE DOIVENT JAMAIS apparaître dans la
    // response — garde-fou anti-leak forensics
    expect(bodyText).not.toContain(FAKE_CREATE_RESULT.passwordGenerated);
    expect(bodyText).not.toContain(FAKE_CREATE_RESULT.twentyApiKeyToken);
    // Le magic-link (qui est un token signé court-vie, public-by-design) PEUT
    // apparaître — c'est le but de la response
    expect(bodyText).toContain(FAKE_CREATE_RESULT.initialMagicLinkUrl);
  });

  it('ne tente PAS regenerateMagicLink si CrmTenant existe mais status != active', async () => {
    getCurrentUserMock.mockResolvedValueOnce(FAKE_USER);
    getCrmTenantByUserIdMock.mockResolvedValueOnce({
      ...FAKE_CRM_TENANT_ACTIVE,
      status: 'suspended',
    });
    getCrmTenantByEmailMock.mockResolvedValueOnce(null);
    createTenantMock.mockResolvedValueOnce(FAKE_CREATE_RESULT);
    prismaCrmTenantCreateMock.mockResolvedValueOnce({ id: 'x' });

    const res = await POST(makeRequest());
    // Tombe dans la branche createTenant (créer un nouveau), pas regen
    expect(regenerateMagicLinkMock).not.toHaveBeenCalled();
    expect(createTenantMock).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
