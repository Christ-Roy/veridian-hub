/**
 * Tests pour POST /api/admin/crm/create-tenant.
 *
 * Couvre :
 *  - 401 si authenticateAdmin denied
 *  - 400 si payload invalide (email manquant, workspace_name avec ctrl chars)
 *  - 404 si user Hub inexistant ou sans supabaseUserId
 *  - 502 si CrmClientError remonte (upstream Twenty down ou GraphQL error)
 *  - 500 si vault indisponible (CRM_VAULT_KEY manquante en runtime)
 *  - 201 happy path : tenant créé + audit log + response ne contient PAS
 *    le Bearer ni le password
 *  - 200 idempotent : email déjà actif → regen magic link, pas de re-provision
 *  - audit log écrit avec idempotent=true vs false selon le cas
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { CrmClientError } from '@/lib/crm/types';

const findUniqueUserMock = vi.fn();
const findFirstCrmMock = vi.fn();
const findUniqueCrmMock = vi.fn();
const createCrmMock = vi.fn();
const authenticateAdminMock = vi.fn();
const writeAuditLogMock = vi.fn();
const createTenantMock = vi.fn();
const regenerateMagicLinkMock = vi.fn();
const encryptSecretMock = vi.fn();
const decryptSecretMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: findUniqueUserMock },
    crmTenant: {
      findFirst: findFirstCrmMock,
      findUnique: findUniqueCrmMock,
      create: createCrmMock,
    },
  },
}));

vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));

vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  resolveActor: () => 'token:ADMIN_SECRET',
}));

vi.mock('@/lib/crm/client', () => ({
  createCrmClientFromEnv: () => ({
    createTenant: (...args: unknown[]) => createTenantMock(...args),
    regenerateMagicLink: (...args: unknown[]) => regenerateMagicLinkMock(...args),
  }),
}));

vi.mock('@/lib/crm/vault', () => ({
  encryptSecret: (...args: unknown[]) => encryptSecretMock(...args),
  decryptSecret: (...args: unknown[]) => decryptSecretMock(...args),
}));

const ORIG_VAULT_KEY = process.env.CRM_VAULT_KEY;

const authOK = { ok: true, sessionEmail: null };
const authDenied401 = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

beforeEach(() => {
  findUniqueUserMock.mockReset();
  findFirstCrmMock.mockReset();
  findUniqueCrmMock.mockReset();
  createCrmMock.mockReset();
  authenticateAdminMock.mockReset();
  writeAuditLogMock.mockReset();
  createTenantMock.mockReset();
  regenerateMagicLinkMock.mockReset();
  encryptSecretMock.mockReset();
  decryptSecretMock.mockReset();

  authenticateAdminMock.mockResolvedValue(authOK);
  encryptSecretMock.mockImplementation((p: string) => `enc(${p})`);
  decryptSecretMock.mockImplementation((c: string) => c.replace(/^enc\(/, '').replace(/\)$/, ''));

  process.env.CRM_VAULT_KEY = 'dummy-test-key-not-used-because-mocked';
});

afterAll(() => {
  if (ORIG_VAULT_KEY === undefined) delete process.env.CRM_VAULT_KEY;
  else process.env.CRM_VAULT_KEY = ORIG_VAULT_KEY;
});

const validPayload = {
  email: 'client@example.com',
  workspace_name: 'Acme Corp',
};

const makeReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/admin/crm/create-tenant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const sampleProvisionResult = {
  twentyWorkspaceId: 'a89ddd99-960b-46a4-a6a6-1696b02cd9c5',
  twentyWorkspaceUrl: 'https://acme.crm.staging.example.com/',
  twentyApiKeyId: '3208b4fe-1423-4de7-91e1-c3d6344729a6',
  twentyApiKeyToken: 'bearer-jwt-real-600chars',
  twentyApiKeyExpiresAt: new Date('2027-05-27T12:00:00Z'),
  passwordGenerated: 'random-32B-base64url-secret',
  initialMagicLinkUrl: 'https://acme.crm.staging.example.com/verify?loginToken=abc',
};

const sampleCreatedRow = {
  id: 'hub-crm-tenant-uuid',
  twentyWorkspaceId: sampleProvisionResult.twentyWorkspaceId,
  twentyWorkspaceUrl: sampleProvisionResult.twentyWorkspaceUrl,
  twentyApiKeyId: sampleProvisionResult.twentyApiKeyId,
  twentyApiKeyExpiresAt: sampleProvisionResult.twentyApiKeyExpiresAt,
  createdAt: new Date('2026-05-27T12:00:00Z'),
};

describe('POST /api/admin/crm/create-tenant', () => {
  it('401 if authenticateAdmin denies', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied401);
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);
    expect(res.status).toBe(401);
    expect(createTenantMock).not.toHaveBeenCalled();
  });

  it('400 if email missing', async () => {
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(
      makeReq({ workspace_name: 'X' }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  it('400 if email malformed', async () => {
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(
      makeReq({ ...validPayload, email: 'not-an-email' }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('400 if workspace_name contains control chars', async () => {
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(
      makeReq({ ...validPayload, workspace_name: 'Acme\x00<script>' }) as never,
    );
    expect(res.status).toBe(400);
    expect(createTenantMock).not.toHaveBeenCalled();
  });

  it('400 if workspace_name empty', async () => {
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(
      makeReq({ ...validPayload, workspace_name: '' }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('404 if user Hub not found', async () => {
    findUniqueUserMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('user_not_found');
  });

  it('404 if user has no supabaseUserId (legacy bridge missing)', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'cuid', supabaseUserId: null });
    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);
    expect(res.status).toBe(404);
  });

  it('201 happy path : creates tenant, writes audit log, no Bearer in response', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'cuid', supabaseUserId: 'user-uuid' });
    findFirstCrmMock.mockResolvedValueOnce(null); // pas d'existant
    createTenantMock.mockResolvedValueOnce(sampleProvisionResult);
    createCrmMock.mockResolvedValueOnce(sampleCreatedRow);

    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);

    expect(res.status).toBe(201);
    const body = await res.json();

    // Response shape — pas de Bearer ni password
    expect(body).toMatchObject({
      tenantId: 'hub-crm-tenant-uuid',
      twentyWorkspaceId: sampleProvisionResult.twentyWorkspaceId,
      twentyWorkspaceUrl: sampleProvisionResult.twentyWorkspaceUrl,
      twentyApiKeyId: sampleProvisionResult.twentyApiKeyId,
      magicLinkUrl: sampleProvisionResult.initialMagicLinkUrl,
      idempotent: false,
    });
    expect(JSON.stringify(body)).not.toContain('bearer-jwt-real');
    expect(JSON.stringify(body)).not.toContain('random-32B-base64url');

    // Vault chiffre les 2 secrets
    expect(encryptSecretMock).toHaveBeenCalledWith('bearer-jwt-real-600chars');
    expect(encryptSecretMock).toHaveBeenCalledWith('random-32B-base64url-secret');

    // Prisma create reçoit les valeurs chiffrées (pas les claires)
    const createArg = createCrmMock.mock.calls[0][0].data;
    expect(createArg.twentyApiKeyEncrypted).toBe('enc(bearer-jwt-real-600chars)');
    expect(createArg.twentyPasswordEncrypted).toBe('enc(random-32B-base64url-secret)');
    expect(createArg.userId).toBe('user-uuid');
    expect(createArg.email).toBe('client@example.com');
    expect(createArg.status).toBe('active');

    // Audit log écrit
    expect(writeAuditLogMock).toHaveBeenCalledOnce();
    const auditArg = writeAuditLogMock.mock.calls[0][1];
    expect(auditArg.action).toBe('admin.crm.tenant.create');
    expect(auditArg.targetId).toBe('hub-crm-tenant-uuid');
    expect(auditArg.payload.idempotent).toBe(false);
    // Audit ne doit JAMAIS contenir le Bearer ni le password
    expect(JSON.stringify(auditArg.payload)).not.toContain('bearer-jwt-real');
    expect(JSON.stringify(auditArg.payload)).not.toContain('random-32B-base64url');
  });

  it('normalizes email to lowercase before lookup + INSERT', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'cuid', supabaseUserId: 'user-uuid' });
    findFirstCrmMock.mockResolvedValueOnce(null);
    createTenantMock.mockResolvedValueOnce(sampleProvisionResult);
    createCrmMock.mockResolvedValueOnce(sampleCreatedRow);

    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    await POST(makeReq({ ...validPayload, email: '  Client@EXAMPLE.com  ' }) as never);

    expect(findUniqueUserMock).toHaveBeenCalledWith({
      where: { email: 'client@example.com' },
      select: { id: true, supabaseUserId: true },
    });
    expect(createCrmMock.mock.calls[0][0].data.email).toBe('client@example.com');
  });

  it('200 idempotent : if email already has an active tenant, regen magic link + no re-provision', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'cuid', supabaseUserId: 'user-uuid' });
    const existingSafeView = {
      id: 'existing-tenant-uuid',
      email: 'client@example.com',
      twentyWorkspaceUrl: 'https://acme.crm/',
      twentyWorkspaceId: 'ws-uuid',
      twentyApiKeyId: 'apikey-uuid',
      twentyApiKeyExpiresAt: new Date('2027-05-27T12:00:00Z'),
      createdAt: new Date('2026-05-20T12:00:00Z'),
    };
    findFirstCrmMock.mockResolvedValueOnce(existingSafeView);
    findUniqueCrmMock.mockResolvedValueOnce({
      id: 'existing-tenant-uuid',
      email: 'client@example.com',
      twentyWorkspaceUrl: 'https://acme.crm/',
      twentyWorkspaceId: 'ws-uuid',
      twentyApiKeyId: 'apikey-uuid',
      twentyApiKeyExpiresAt: new Date('2027-05-27T12:00:00Z'),
      twentyPasswordEncrypted: 'enc(stored-password)',
      createdAt: new Date('2026-05-20T12:00:00Z'),
    });
    regenerateMagicLinkMock.mockResolvedValueOnce({
      magicLinkUrl: 'https://acme.crm/verify?loginToken=regen',
      expiresAt: new Date('2026-05-27T13:00:00Z'),
    });

    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.tenantId).toBe('existing-tenant-uuid');
    expect(body.magicLinkUrl).toBe('https://acme.crm/verify?loginToken=regen');

    // CRUCIAL : pas de re-provision Twenty (sinon doublon signUp)
    expect(createTenantMock).not.toHaveBeenCalled();
    expect(createCrmMock).not.toHaveBeenCalled();

    // Le password est bien déchiffré via le vault
    expect(decryptSecretMock).toHaveBeenCalledWith('enc(stored-password)');

    // Audit log écrit avec idempotent=true
    const auditArg = writeAuditLogMock.mock.calls[0][1];
    expect(auditArg.action).toBe('admin.crm.tenant.create');
    expect(auditArg.payload.idempotent).toBe(true);
  });

  it('502 if CrmClientError remonte du flow create', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'cuid', supabaseUserId: 'user-uuid' });
    findFirstCrmMock.mockResolvedValueOnce(null);
    createTenantMock.mockRejectedValueOnce(
      new CrmClientError('signUp: email already exists in Twenty', {
        step: 'signUpInWorkspace',
        status: 200,
      }),
    );

    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('crm_upstream_error');
    expect(body.step).toBe('signUpInWorkspace');
    expect(createCrmMock).not.toHaveBeenCalled();
  });

  it('500 vault_unavailable if encryptSecret throws (CRM_VAULT_KEY config invalid)', async () => {
    findUniqueUserMock.mockResolvedValueOnce({ id: 'cuid', supabaseUserId: 'user-uuid' });
    findFirstCrmMock.mockResolvedValueOnce(null);
    createTenantMock.mockResolvedValueOnce(sampleProvisionResult);
    encryptSecretMock.mockImplementationOnce(() => {
      throw new Error('CRM_VAULT_KEY env var missing');
    });

    const { POST } = await import('@/app/api/admin/crm/create-tenant/route');
    const res = await POST(makeReq(validPayload) as never);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('vault_unavailable');
    // Signale le workspace_id orphelin pour cleanup manuel
    expect(body.twenty_workspace_id).toBe(sampleProvisionResult.twentyWorkspaceId);
    expect(createCrmMock).not.toHaveBeenCalled();
  });
});
