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
 *
 * ─── Écriture Twenty par tenant (parité bridge §4c, ajout 2026-06-17) ──────
 * Portage des tests du bridge `veridian-tunnel-de-vente/bridge/tests/
 * writer.test.ts` vers le Hub. Le bridge testait son `TwentyWriter` (store +
 * client) ; ici on teste le CONTRAT des méthodes d'écriture du CrmClient (le
 * writer/cron est un AUTRE agent — périmètre L4) :
 *  - resolveByEmail / resolveBySlug : bon filtre REST, parse Person
 *  - resolvePersonCached : voie par la FORME (@ = email, sinon slug) + cache TTL
 *  - batchTimeline : happensAt normalisé .toISOString(), micro-précision, >60
 *  - patchPerson : score + doNotContact
 *  - opportunityForPerson + patchOpportunityStage : read-then-patch
 *  - DRY_RUN : mutations LOGUÉES (pas envoyées), lectures RÉELLES — garde-fou
 *  - rate-limit : token bucket ≤60 req/min (throw 429 au-delà, reset fenêtre)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CrmClient } from '@/lib/crm/client';
import { CrmClientError, type TwentyWriteContext } from '@/lib/crm/types';

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

// ═══════════════════════════════════════════════════════════════════════════
// Écriture Twenty par tenant (parité bridge §4c)
// ═══════════════════════════════════════════════════════════════════════════

const CTX: TwentyWriteContext = {
  baseUrl: 'https://acme.crm.staging.example.com/',
  bearer: 'tenant-bearer-real',
};

/** Person trouvée par filter REST. */
function peopleResponse(person: Record<string, unknown> | null): Response {
  return jsonResponse(200, { data: { people: person ? [person] : [] } });
}

function oppResponse(opp: Record<string, unknown> | null): Response {
  return jsonResponse(200, { data: { opportunities: opp ? [opp] : [] } });
}

interface WriteFetchCall {
  url: string;
  method: string;
  body: unknown;
  authorization?: string;
}

/** Mock fetch qui replay une suite de réponses + capture url/method/body. */
function mockWriteFetch(responses: Response[]): {
  fetchImpl: ReturnType<typeof vi.fn>;
  calls: WriteFetchCall[];
} {
  const calls: WriteFetchCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers?.['Authorization'],
    });
    if (i >= responses.length) throw new Error(`mockWriteFetch exhausted at call ${i}`);
    return responses[i++];
  });
  return { fetchImpl, calls };
}

function buildWriteClient(
  fetchImpl: typeof fetch,
  overrides: Partial<{ dryRun: boolean; now: () => number }> = {},
): CrmClient {
  return new CrmClient({
    metadataUrl: METADATA_URL,
    restUrl: REST_URL,
    frontendUrl: FRONTEND_URL,
    fetchImpl,
    ...overrides,
  });
}

describe('CrmClient.resolveByEmail / resolveBySlug', () => {
  it('resolveByEmail : filtre emails.primaryEmail[eq], parse id + doNotContact', async () => {
    const { fetchImpl, calls } = mockWriteFetch([
      peopleResponse({ id: 'P1', doNotContact: true }),
    ]);
    const client = buildWriteClient(fetchImpl);

    const person = await client.resolveByEmail(CTX, 'p@x.fr');

    expect(person).toEqual({ id: 'P1', stage: null, doNotContact: true });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('https://acme.crm.staging.example.com/rest/people');
    expect(decodeURIComponent(calls[0].url)).toContain('emails.primaryEmail[eq]:"p@x.fr"');
    // Bearer = celui du tenant (ctx), pas un secret figé au client
    expect(calls[0].authorization).toBe('Bearer tenant-bearer-real');
  });

  it('resolveBySlug : filtre auditSlug[eq]', async () => {
    const { fetchImpl, calls } = mockWriteFetch([peopleResponse({ id: 'P2' })]);
    const client = buildWriteClient(fetchImpl);

    const person = await client.resolveBySlug(CTX, 'tramtech-x7k2q1aa');

    expect(person).toEqual({ id: 'P2', stage: null, doNotContact: false });
    expect(decodeURIComponent(calls[0].url)).toContain('auditSlug[eq]:"tramtech-x7k2q1aa"');
  });

  it('Person introuvable → null (jamais de création)', async () => {
    const { fetchImpl } = mockWriteFetch([peopleResponse(null)]);
    const client = buildWriteClient(fetchImpl);
    expect(await client.resolveByEmail(CTX, 'inconnu@x.fr')).toBeNull();
  });

  it('resolve REST non-OK → CrmClientError', async () => {
    const { fetchImpl } = mockWriteFetch([jsonResponse(401, 'unauthorized')]);
    const client = buildWriteClient(fetchImpl);
    await expect(client.resolveByEmail(CTX, 'p@x.fr')).rejects.toMatchObject({
      name: 'CrmClientError',
      status: 401,
    });
  });
});

describe('CrmClient.resolvePersonCached — voie par la FORME + cache', () => {
  it('identité avec @ → resolveByEmail ; sans @ → resolveBySlug', async () => {
    const { fetchImpl, calls } = mockWriteFetch([
      peopleResponse({ id: 'PE' }),
      peopleResponse({ id: 'PS' }),
    ]);
    const client = buildWriteClient(fetchImpl);

    await client.resolvePersonCached(CTX, 'p@x.fr');
    await client.resolvePersonCached(CTX, 'tramtech-x7k2q1aa');

    expect(decodeURIComponent(calls[0].url)).toContain('emails.primaryEmail[eq]');
    expect(decodeURIComponent(calls[1].url)).toContain('auditSlug[eq]');
  });

  it('cache TTL 24h : 2e résolution même identité → 0 fetch supplémentaire', async () => {
    const { fetchImpl, calls } = mockWriteFetch([peopleResponse({ id: 'P1' })]);
    const client = buildWriteClient(fetchImpl);

    const first = await client.resolvePersonCached(CTX, 'p@x.fr');
    const second = await client.resolvePersonCached(CTX, 'p@x.fr');

    expect(first?.id).toBe('P1');
    expect(second?.id).toBe('P1');
    expect(calls).toHaveLength(1); // 2e call servi par le cache
  });

  it('cache expiré (> 24h) → re-resolve', async () => {
    let clock = 1_000_000;
    const { fetchImpl, calls } = mockWriteFetch([
      peopleResponse({ id: 'P1' }),
      peopleResponse({ id: 'P1' }),
    ]);
    const client = buildWriteClient(fetchImpl, { now: () => clock });

    await client.resolvePersonCached(CTX, 'p@x.fr');
    clock += 25 * 60 * 60 * 1000; // +25h > TTL
    await client.resolvePersonCached(CTX, 'p@x.fr');

    expect(calls).toHaveLength(2);
  });

  it('cache keyé par workspace : même identité, 2 tenants → 2 resolves', async () => {
    const { fetchImpl, calls } = mockWriteFetch([
      peopleResponse({ id: 'P1' }),
      peopleResponse({ id: 'P2' }),
    ]);
    const client = buildWriteClient(fetchImpl);

    await client.resolvePersonCached(CTX, 'p@x.fr');
    await client.resolvePersonCached(
      { baseUrl: 'https://other.crm.example.com', bearer: 'b2' },
      'p@x.fr',
    );

    expect(calls).toHaveLength(2);
  });
});

describe('CrmClient.batchTimeline', () => {
  it('happensAt = event_timestamp vrai, normalisé .toISOString() + createdBy API', async () => {
    const { fetchImpl, calls } = mockWriteFetch([jsonResponse(200, {})]);
    const client = buildWriteClient(fetchImpl);

    await client.batchTimeline(CTX, [
      {
        name: 'email.clicked',
        happensAt: '2026-06-10T10:00:00Z',
        targetPersonId: 'P1',
        properties: { eventId: 'e1', source: 'notifuse' },
      },
    ]);

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'https://acme.crm.staging.example.com/rest/batch/timelineActivities',
    );
    const sent = calls[0].body as Array<Record<string, unknown>>;
    expect(sent[0].happensAt).toBe('2026-06-10T10:00:00.000Z');
    expect(sent[0].createdBy).toEqual({ source: 'API' });
    expect(sent[0].name).toBe('email.clicked');
  });

  it('happensAt micro-précision Postgres (.52305Z) → normalisé ISO ms', async () => {
    // Cas réel run5 : timestamps Postgres à 5 décimales → Twenty 400 sinon.
    const { fetchImpl, calls } = mockWriteFetch([jsonResponse(200, {})]);
    const client = buildWriteClient(fetchImpl);

    await client.batchTimeline(CTX, [
      {
        name: 'email.sent',
        happensAt: '2026-06-10T23:49:59.52305Z',
        targetPersonId: 'P1',
        properties: {},
      },
    ]);

    const sent = calls[0].body as Array<Record<string, unknown>>;
    expect(sent[0].happensAt).toBe('2026-06-10T23:49:59.523Z');
  });

  it('happensAt illisible → fallback now ISO (jamais de brut vers Twenty)', async () => {
    const { fetchImpl, calls } = mockWriteFetch([jsonResponse(200, {})]);
    const client = buildWriteClient(fetchImpl);

    await client.batchTimeline(CTX, [
      { name: 'email.sent', happensAt: 'pas-une-date', targetPersonId: 'P1', properties: {} },
    ]);

    const sent = calls[0].body as Array<Record<string, unknown>>;
    expect(String(sent[0].happensAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('batch > 60 → throw CrmClientError (contrat §4c.2)', async () => {
    const { fetchImpl } = mockWriteFetch([]);
    const client = buildWriteClient(fetchImpl);
    const items = Array.from({ length: 61 }, (_, i) => ({
      name: 'email.sent',
      happensAt: '2026-06-10T10:00:00Z',
      targetPersonId: `P${i}`,
      properties: {},
    }));
    await expect(client.batchTimeline(CTX, items)).rejects.toMatchObject({
      name: 'CrmClientError',
      step: 'batchTimeline',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('batch vide → 0 fetch', async () => {
    const { fetchImpl } = mockWriteFetch([]);
    const client = buildWriteClient(fetchImpl);
    await client.batchTimeline(CTX, []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('batch REST non-OK → CrmClientError (replay possible côté caller)', async () => {
    const { fetchImpl } = mockWriteFetch([jsonResponse(400, 'bad happensAt')]);
    const client = buildWriteClient(fetchImpl);
    await expect(
      client.batchTimeline(CTX, [
        { name: 'email.sent', happensAt: '2026-06-10T10:00:00Z', targetPersonId: 'P1', properties: {} },
      ]),
    ).rejects.toMatchObject({ name: 'CrmClientError', status: 400 });
  });
});

describe('CrmClient.patchPerson — score + doNotContact (§4c.4 / §4c.5)', () => {
  it('PATCH /rest/people/{id} avec score', async () => {
    const { fetchImpl, calls } = mockWriteFetch([jsonResponse(200, {})]);
    const client = buildWriteClient(fetchImpl);

    await client.patchPerson(CTX, 'P1', { score: 45 });

    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://acme.crm.staging.example.com/rest/people/P1');
    expect(calls[0].body).toEqual({ score: 45 });
  });

  it('PATCH doNotContact=true (disqualif unsubscribe / hard bounce)', async () => {
    const { fetchImpl, calls } = mockWriteFetch([jsonResponse(200, {})]);
    const client = buildWriteClient(fetchImpl);

    await client.patchPerson(CTX, 'P1', { doNotContact: true });

    expect(calls[0].body).toEqual({ doNotContact: true });
  });
});

describe('CrmClient.opportunityForPerson + patchOpportunityStage (§4c.6)', () => {
  it('opportunityForPerson : filtre pointOfContactId, parse id + stage', async () => {
    const { fetchImpl, calls } = mockWriteFetch([oppResponse({ id: 'O1', stage: 'NEW' })]);
    const client = buildWriteClient(fetchImpl);

    const opp = await client.opportunityForPerson(CTX, 'P1');

    expect(opp).toEqual({ id: 'O1', stage: 'NEW' });
    expect(decodeURIComponent(calls[0].url)).toContain('pointOfContactId[eq]:"P1"');
  });

  it('opportunityForPerson : aucune → null', async () => {
    const { fetchImpl } = mockWriteFetch([oppResponse(null)]);
    const client = buildWriteClient(fetchImpl);
    expect(await client.opportunityForPerson(CTX, 'P1')).toBeNull();
  });

  it('read-then-patch NEW→SCREENING : le caller lit puis patch (jamais de recul)', async () => {
    // Le client ne décide pas du recul — c'est le caller (cron) qui lit le
    // stage avant de patcher. On vérifie que le PATCH part bien tel quel.
    const { fetchImpl, calls } = mockWriteFetch([
      oppResponse({ id: 'O1', stage: 'NEW' }),
      jsonResponse(200, {}),
    ]);
    const client = buildWriteClient(fetchImpl);

    const opp = await client.opportunityForPerson(CTX, 'P1');
    expect(opp?.stage).toBe('NEW');
    await client.patchOpportunityStage(CTX, opp!.id, 'SCREENING');

    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toBe('https://acme.crm.staging.example.com/rest/opportunities/O1');
    expect(calls[1].body).toEqual({ stage: 'SCREENING' });
  });
});

describe('CrmClient — DRY_RUN (garde-fou critique)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('dryRun client : les MUTATIONS sont loguées, AUCUN fetch envoyé', async () => {
    const { fetchImpl } = mockWriteFetch([]);
    const client = buildWriteClient(fetchImpl, { dryRun: true });

    await client.batchTimeline(CTX, [
      { name: 'email.sent', happensAt: '2026-06-10T10:00:00Z', targetPersonId: 'P1', properties: {} },
    ]);
    await client.patchPerson(CTX, 'P1', { score: 90 });
    await client.patchPerson(CTX, 'P1', { doNotContact: true });
    await client.patchOpportunityStage(CTX, 'O1', 'SCREENING');

    expect(fetchImpl).not.toHaveBeenCalled(); // ZÉRO mutation réseau
    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[DRY_RUN]') && l.includes('timelineActivities'))).toBe(true);
    expect(logged.some((l) => l.includes('[DRY_RUN]') && l.includes('/rest/people/P1'))).toBe(true);
    expect(logged.some((l) => l.includes('[DRY_RUN]') && l.includes('/rest/opportunities/O1'))).toBe(true);
  });

  it('dryRun client : les LECTURES restent RÉELLES (resolve, opportunity)', async () => {
    const { fetchImpl, calls } = mockWriteFetch([
      peopleResponse({ id: 'P1' }),
      oppResponse({ id: 'O1', stage: 'NEW' }),
    ]);
    const client = buildWriteClient(fetchImpl, { dryRun: true });

    const person = await client.resolveByEmail(CTX, 'p@x.fr');
    const opp = await client.opportunityForPerson(CTX, 'P1');

    expect(person?.id).toBe('P1'); // lecture réelle
    expect(opp?.id).toBe('O1');
    expect(calls).toHaveLength(2); // les 2 GET sont bien partis
  });

  it('override par-appel : dryRun=true force le log même si client live', async () => {
    const { fetchImpl } = mockWriteFetch([]);
    const client = buildWriteClient(fetchImpl, { dryRun: false });

    await client.patchPerson(CTX, 'P1', { score: 10 }, { dryRun: true });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('override par-appel : dryRun=false force l’envoi même si client dryRun', async () => {
    const { fetchImpl, calls } = mockWriteFetch([jsonResponse(200, {})]);
    const client = buildWriteClient(fetchImpl, { dryRun: true });

    await client.patchPerson(CTX, 'P1', { score: 10 }, { dryRun: false });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
  });
});

describe('CrmClient — token bucket ≤60 req/min (parité bridge §6.2)', () => {
  it('le 61e appel mutation dans la fenêtre throw 429 (budget épuisé)', async () => {
    const responses = Array.from({ length: 61 }, () => jsonResponse(200, {}));
    const { fetchImpl, calls } = mockWriteFetch(responses);
    const client = buildWriteClient(fetchImpl, { now: () => 1_000_000 }); // horloge figée

    for (let i = 0; i < 60; i++) {
      await client.patchPerson(CTX, `P${i}`, { score: i });
    }
    expect(calls).toHaveLength(60); // 60 partis, budget plein

    await expect(client.patchPerson(CTX, 'P60', { score: 60 })).rejects.toMatchObject({
      name: 'CrmClientError',
      status: 429,
    });
    expect(calls).toHaveLength(60); // le 61e n'a PAS touché le réseau
  });

  it('fenêtre minute glissante : après 60s le budget se réarme', async () => {
    let clock = 1_000_000;
    const responses = Array.from({ length: 61 }, () => jsonResponse(200, {}));
    const { fetchImpl, calls } = mockWriteFetch(responses);
    const client = buildWriteClient(fetchImpl, { now: () => clock });

    for (let i = 0; i < 60; i++) {
      await client.patchPerson(CTX, `P${i}`, { score: i });
    }
    clock += 60_001; // nouvelle fenêtre
    await client.patchPerson(CTX, 'P60', { score: 60 }); // re-autorisé

    expect(calls).toHaveLength(61);
  });

  it('le budget compte AUSSI les lectures opportunity (read-then-patch sous budget)', async () => {
    const responses = Array.from({ length: 61 }, () => oppResponse({ id: 'O', stage: 'NEW' }));
    const { fetchImpl } = mockWriteFetch(responses);
    const client = buildWriteClient(fetchImpl, { now: () => 1_000_000 });

    for (let i = 0; i < 60; i++) {
      await client.opportunityForPerson(CTX, `P${i}`);
    }
    await expect(client.opportunityForPerson(CTX, 'P60')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('DRY_RUN ne consomme PAS de budget (mutation loguée, pas comptée)', async () => {
    const { fetchImpl, calls } = mockWriteFetch(
      Array.from({ length: 5 }, () => jsonResponse(200, {})),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = buildWriteClient(fetchImpl, { dryRun: true, now: () => 1_000_000 });

    // 100 patchs en DRY_RUN — aucun ne consomme le budget
    for (let i = 0; i < 100; i++) {
      await client.patchPerson(CTX, `P${i}`, { score: i });
    }
    // puis 5 patchs LIVE doivent passer (budget intact)
    for (let i = 0; i < 5; i++) {
      await client.patchPerson(CTX, `L${i}`, { score: i }, { dryRun: false });
    }
    expect(calls).toHaveLength(5);
    logSpy.mockRestore();
  });
});

describe('CrmClient — resetWriteBudget', () => {
  it('resetWriteBudget réarme le compteur', async () => {
    const responses = Array.from({ length: 61 }, () => jsonResponse(200, {}));
    const { fetchImpl, calls } = mockWriteFetch(responses);
    const client = buildWriteClient(fetchImpl, { now: () => 1_000_000 });

    for (let i = 0; i < 60; i++) {
      await client.patchPerson(CTX, `P${i}`, { score: i });
    }
    client.resetWriteBudget();
    await client.patchPerson(CTX, 'P60', { score: 60 }); // re-autorisé
    expect(calls).toHaveLength(61);
  });
});
