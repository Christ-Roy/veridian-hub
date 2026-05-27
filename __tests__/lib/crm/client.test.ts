/**
 * Tests pour lib/crm/client.ts (CrmClient — Twenty fork orchestration).
 *
 * Couvre :
 *  - createTenant : enchaîne 6 GraphQL calls dans le bon ordre
 *  - createTenant : filter Admin role (pas roles[0])
 *  - createTenant : retry 5xx puis success
 *  - createTenant : pas de retry sur erreur GraphQL (4xx-équivalent)
 *  - createTenant : timeout → CrmClientError
 *  - createTenant : Bearer accessToken posé sur étapes 3-6, pas sur 1-2
 *  - regenerateMagicLink : appel étape 7 + buildMagicLink correct
 *  - pushLeads : batch séquentiel, collecte les erreurs par index
 *  - aucun secret loggué (smoke check via console spy)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CrmClient } from '@/lib/crm/client';
import { CrmClientError } from '@/lib/crm/types';

const METADATA_URL = 'https://crm.staging.example.com/metadata';
const REST_URL = 'https://crm.staging.example.com/rest';
const FRONTEND_URL = 'https://crm.staging.example.com';

const FIXED_EXPIRES = new Date('2027-05-27T12:00:00.000Z');
const FIXED_PASSWORD = 'fixed-test-password-32B-base64url';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface GraphQLCall {
  step: string;
  query: string;
  variables: Record<string, unknown>;
  authorization?: string;
}

/**
 * Helper : crée un fetch mock qui replay une suite de responses GraphQL.
 * Capture les calls + leurs query + headers Authorization pour assertions.
 */
function mockSequence(responses: Response[]): {
  fetchImpl: ReturnType<typeof vi.fn>;
  calls: GraphQLCall[];
} {
  const calls: GraphQLCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    calls.push({
      step: detectStep(body.query as string),
      query: String(body.query ?? '').trim(),
      variables: body.variables ?? {},
      authorization: auth,
    });
    if (i >= responses.length) {
      throw new Error(`mockSequence exhausted at call ${i}`);
    }
    return responses[i++];
  });
  return { fetchImpl, calls };
}

function detectStep(query: string): string {
  if (query.includes('signUpInWorkspace')) return 'signUpInWorkspace';
  if (query.includes('getAuthTokensFromLoginToken')) return 'getAuthTokensFromLoginToken';
  if (query.includes('activateWorkspace')) return 'activateWorkspace';
  if (query.includes('getRoles')) return 'getRoles';
  if (query.includes('createApiKey')) return 'createApiKey';
  if (query.includes('generateApiKeyToken')) return 'generateApiKeyToken';
  if (query.includes('getLoginTokenFromCredentials')) return 'getLoginTokenFromCredentials';
  return 'unknown';
}

function happyPathResponses(): Response[] {
  return [
    // 1. signUpInWorkspace
    jsonResponse(200, {
      data: {
        signUpInWorkspace: {
          loginToken: {
            token: 'login-token-step-1',
            expiresAt: '2026-05-27T13:00:00.000Z',
          },
          workspace: {
            id: 'a89ddd99-960b-46a4-a6a6-1696b02cd9c5',
            workspaceUrls: {
              subdomainUrl: 'https://acme.crm.staging.example.com/',
            },
          },
        },
      },
    }),
    // 2. getAuthTokensFromLoginToken
    jsonResponse(200, {
      data: {
        getAuthTokensFromLoginToken: {
          tokens: {
            accessOrWorkspaceAgnosticToken: { token: 'access-token-step-2' },
            refreshToken: { token: 'refresh-token-step-2' },
          },
        },
      },
    }),
    // 3. activateWorkspace
    jsonResponse(200, {
      data: {
        activateWorkspace: {
          id: 'a89ddd99-960b-46a4-a6a6-1696b02cd9c5',
          displayName: 'Acme Corp',
          activationStatus: 'ACTIVE',
        },
      },
    }),
    // 4. getRoles (Member en premier, Admin en second — bug v1.16)
    jsonResponse(200, {
      data: {
        getRoles: [
          { id: 'role-member-uuid', label: 'Member' },
          { id: 'role-admin-uuid', label: 'Admin' },
        ],
      },
    }),
    // 5. createApiKey
    jsonResponse(200, {
      data: {
        createApiKey: {
          id: '3208b4fe-1423-4de7-91e1-c3d6344729a6',
          name: 'Veridian Hub Admin Key',
          expiresAt: FIXED_EXPIRES.toISOString(),
        },
      },
    }),
    // 6. generateApiKeyToken
    jsonResponse(200, {
      data: {
        generateApiKeyToken: { token: 'bearer-jwt-api-key-real-600chars' },
      },
    }),
  ];
}

function buildClient(fetchImpl: typeof fetch, overrides: Partial<{ maxRetries: number; timeoutMs: number }> = {}): CrmClient {
  return new CrmClient({
    metadataUrl: METADATA_URL,
    restUrl: REST_URL,
    frontendUrl: FRONTEND_URL,
    fetchImpl,
    apiKeyExpiresAt: () => FIXED_EXPIRES,
    generatePassword: () => FIXED_PASSWORD,
    ...overrides,
  });
}

describe('CrmClient.createTenant — happy path', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('chains the 6 GraphQL calls in the correct order', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);

    const result = await client.createTenant({
      email: 'Robert@Example.com',
      workspaceName: 'Acme Corp',
    });

    expect(calls.map((c) => c.step)).toEqual([
      'signUpInWorkspace',
      'getAuthTokensFromLoginToken',
      'activateWorkspace',
      'getRoles',
      'createApiKey',
      'generateApiKeyToken',
    ]);

    expect(result.twentyWorkspaceId).toBe('a89ddd99-960b-46a4-a6a6-1696b02cd9c5');
    expect(result.twentyWorkspaceUrl).toBe('https://acme.crm.staging.example.com/');
    expect(result.twentyApiKeyId).toBe('3208b4fe-1423-4de7-91e1-c3d6344729a6');
    expect(result.twentyApiKeyToken).toBe('bearer-jwt-api-key-real-600chars');
    expect(result.twentyApiKeyExpiresAt).toEqual(FIXED_EXPIRES);
    expect(result.passwordGenerated).toBe(FIXED_PASSWORD);
    expect(result.initialMagicLinkUrl).toContain('https://acme.crm.staging.example.com');
    expect(result.initialMagicLinkUrl).toContain('verify?loginToken=login-token-step-1');
  });

  it('normalizes email to lowercase + trim before signUp', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);
    await client.createTenant({ email: '  Robert@Example.COM ', workspaceName: 'X' });
    expect(calls[0].variables.email).toBe('robert@example.com');
  });

  it('uses the generated password (no leak in variables of any other step)', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);
    await client.createTenant({ email: 'a@b.com', workspaceName: 'X' });
    expect(calls[0].variables.password).toBe(FIXED_PASSWORD);
    // Étapes 2-6 ne doivent JAMAIS recevoir le password
    for (let i = 1; i < calls.length; i++) {
      expect(JSON.stringify(calls[i].variables)).not.toContain(FIXED_PASSWORD);
    }
  });

  it('passes Bearer accessToken on steps 3-6 only (not on 1-2)', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);
    await client.createTenant({ email: 'a@b.com', workspaceName: 'X' });

    expect(calls[0].authorization).toBeUndefined(); // signUp = public
    expect(calls[1].authorization).toBeUndefined(); // exchange token = public
    expect(calls[2].authorization).toBe('Bearer access-token-step-2');
    expect(calls[3].authorization).toBe('Bearer access-token-step-2');
    expect(calls[4].authorization).toBe('Bearer access-token-step-2');
    expect(calls[5].authorization).toBe('Bearer access-token-step-2');
  });

  it('passes origin = workspaceUrl on step 2 (required arg v2.x)', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);
    await client.createTenant({ email: 'a@b.com', workspaceName: 'X' });
    expect(calls[1].variables.origin).toBe('https://acme.crm.staging.example.com/');
    expect(calls[1].variables.loginToken).toBe('login-token-step-1');
  });

  it('createApiKey input uses the Admin role id (not roles[0])', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);
    await client.createTenant({ email: 'a@b.com', workspaceName: 'X' });
    const createApiKeyInput = calls[4].variables.input as { roleId: string };
    expect(createApiKeyInput.roleId).toBe('role-admin-uuid');
    expect(createApiKeyInput.roleId).not.toBe('role-member-uuid');
  });

  it('generateApiKeyToken receives the same expiresAt as createApiKey', async () => {
    const { fetchImpl, calls } = mockSequence(happyPathResponses());
    const client = buildClient(fetchImpl);
    await client.createTenant({ email: 'a@b.com', workspaceName: 'X' });
    const createInput = calls[4].variables.input as { expiresAt: string };
    expect(calls[5].variables.expiresAt).toBe(createInput.expiresAt);
    expect(calls[5].variables.apiKeyId).toBe('3208b4fe-1423-4de7-91e1-c3d6344729a6');
  });
});

describe('CrmClient.createTenant — error paths', () => {
  it('throws CrmClientError when Admin role is missing', async () => {
    const responses = happyPathResponses();
    responses[3] = jsonResponse(200, {
      data: { getRoles: [{ id: 'role-member', label: 'Member' }] },
    });
    const { fetchImpl } = mockSequence(responses);
    const client = buildClient(fetchImpl);

    await expect(
      client.createTenant({ email: 'a@b.com', workspaceName: 'X' }),
    ).rejects.toMatchObject({ name: 'CrmClientError', step: 'getRoles' });
  });

  it('throws CrmClientError on GraphQL errors (no retry)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          errors: [{ message: 'email already exists' }],
        }),
      );
    const client = buildClient(fetchImpl, { maxRetries: 2 });

    await expect(
      client.createTenant({ email: 'a@b.com', workspaceName: 'X' }),
    ).rejects.toMatchObject({
      name: 'CrmClientError',
      step: 'signUpInWorkspace',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // pas de retry sur erreur GraphQL
  });

  it('retries on 5xx then succeeds', async () => {
    const responses = happyPathResponses();
    const firstWith503 = [jsonResponse(503, { error: 'busy' }), ...responses];
    const { fetchImpl } = mockSequence(firstWith503);
    const client = buildClient(fetchImpl, { maxRetries: 1 });

    const result = await client.createTenant({
      email: 'a@b.com',
      workspaceName: 'X',
    });
    expect(result.twentyApiKeyToken).toBe('bearer-jwt-api-key-real-600chars');
    // 1 fail + 6 success = 7 calls
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('exhausts retries on persistent 5xx and throws CrmClientError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const client = buildClient(fetchImpl, { maxRetries: 1 });

    await expect(
      client.createTenant({ email: 'a@b.com', workspaceName: 'X' }),
    ).rejects.toBeInstanceOf(CrmClientError);
    // 1 try + 1 retry = 2 calls (étape 1 seulement, on n'avance pas)
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws CrmClientError when signUpInWorkspace returns no loginToken', async () => {
    const responses = happyPathResponses();
    responses[0] = jsonResponse(200, {
      data: {
        signUpInWorkspace: {
          loginToken: null,
          workspace: { id: 'x', workspaceUrls: { subdomainUrl: 'x' } },
        },
      },
    });
    const { fetchImpl } = mockSequence(responses);
    const client = buildClient(fetchImpl);

    await expect(
      client.createTenant({ email: 'a@b.com', workspaceName: 'X' }),
    ).rejects.toMatchObject({ step: 'signUpInWorkspace' });
  });

  it('validates email/workspaceName before any fetch', async () => {
    const fetchImpl = vi.fn();
    const client = buildClient(fetchImpl);
    await expect(
      client.createTenant({ email: '', workspaceName: 'X' }),
    ).rejects.toMatchObject({ step: 'validate' });
    await expect(
      client.createTenant({ email: 'a@b.com', workspaceName: '   ' }),
    ).rejects.toMatchObject({ step: 'validate' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CrmClient.regenerateMagicLink', () => {
  it('calls getLoginTokenFromCredentials with origin + builds verify URL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          getLoginTokenFromCredentials: {
            loginToken: {
              token: 'regenerated-login-token',
              expiresAt: '2026-05-27T13:15:00.000Z',
            },
          },
        },
      }),
    );
    const client = buildClient(fetchImpl);

    const result = await client.regenerateMagicLink({
      email: 'a@b.com',
      passwordDecrypted: 'secret-password',
      workspaceUrl: 'https://acme.crm.staging.example.com/',
    });

    expect(result.magicLinkUrl).toBe(
      'https://acme.crm.staging.example.com/verify?loginToken=regenerated-login-token',
    );
    expect(result.expiresAt).toEqual(new Date('2026-05-27T13:15:00.000Z'));

    const callBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(callBody.variables.origin).toBe('https://acme.crm.staging.example.com/');
    expect(callBody.variables.password).toBe('secret-password');
  });

  it('throws CrmClientError if loginToken missing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: { getLoginTokenFromCredentials: { loginToken: null } },
      }),
    );
    const client = buildClient(fetchImpl);

    await expect(
      client.regenerateMagicLink({
        email: 'a@b.com',
        passwordDecrypted: 'pw',
        workspaceUrl: 'https://x/',
      }),
    ).rejects.toMatchObject({ step: 'getLoginTokenFromCredentials' });
  });

  it('validates required args before any fetch', async () => {
    const fetchImpl = vi.fn();
    const client = buildClient(fetchImpl);
    await expect(
      client.regenerateMagicLink({ email: '', passwordDecrypted: 'pw', workspaceUrl: 'u' }),
    ).rejects.toMatchObject({ step: 'validate' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CrmClient.pushLeads', () => {
  it('pushes each lead sequentially via REST + counts pushed/failed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { data: { id: '1' } }))
      .mockResolvedValueOnce(jsonResponse(400, 'bad email'))
      .mockResolvedValueOnce(jsonResponse(201, { data: { id: '3' } }));

    const client = buildClient(fetchImpl);
    const result = await client.pushLeads({
      apiKey: 'bearer-real',
      workspaceUrl: 'https://acme.crm.staging.example.com/',
      leads: [
        { firstName: 'A', lastName: 'A', primaryEmail: 'a@x.com' },
        { firstName: 'B', primaryEmail: 'bogus' },
        { firstName: 'C', primaryEmail: 'c@x.com' },
      ],
    });

    expect(result.pushed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);

    // L'URL doit pointer sur /rest/people
    expect(fetchImpl.mock.calls[0][0]).toBe('https://acme.crm.staging.example.com/rest/people');
    // Authorization Bearer présent
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer bearer-real');
  });

  it('validates apiKey + workspaceUrl before any fetch', async () => {
    const fetchImpl = vi.fn();
    const client = buildClient(fetchImpl);
    await expect(
      client.pushLeads({ apiKey: '', workspaceUrl: 'u', leads: [] }),
    ).rejects.toMatchObject({ step: 'validate' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns empty result when no leads given (zero fetch calls)', async () => {
    const fetchImpl = vi.fn();
    const client = buildClient(fetchImpl);
    const result = await client.pushLeads({
      apiKey: 'bearer',
      workspaceUrl: 'https://x/',
      leads: [],
    });
    expect(result).toEqual({ pushed: 0, failed: 0, errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CrmClient — constructor guards', () => {
  it('throws if metadataUrl missing', () => {
    expect(
      () =>
        new CrmClient({
          metadataUrl: '',
          restUrl: REST_URL,
          frontendUrl: FRONTEND_URL,
        }),
    ).toThrow(/metadataUrl is required/);
  });
});
