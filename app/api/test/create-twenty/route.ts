/**
 * TEST ROUTE - Twenty Tenant Creation
 *
 * Usage:
 *   curl http://localhost:3000/api/test/create-twenty
 *
 * Cette route est pour TESTER rapidement sans passer par l'UI
 */

import { NextResponse } from 'next/server';

// Force dynamic rendering - prevent static generation at build time
export const dynamic = 'force-dynamic';

const TWENTY_API_URL = process.env.NEXT_PUBLIC_TWENTY_URL
  ? `${process.env.NEXT_PUBLIC_TWENTY_URL}/graphql`
  : 'https://twenty.app.veridian.site/graphql';

const TWENTY_METADATA_URL = process.env.NEXT_PUBLIC_TWENTY_URL
  ? `${process.env.NEXT_PUBLIC_TWENTY_URL}/metadata`
  : 'https://twenty.app.veridian.site/metadata';

const TWENTY_FRONTEND_URL = process.env.NEXT_PUBLIC_TWENTY_URL || 'https://twenty.app.veridian.site';

interface LogEntry {
  timestamp: string;
  step: string;
  type: 'info' | 'success' | 'error';
  message: string;
  data?: any;
}

async function graphqlRequest(url: string, query: string, variables?: any, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET() {
  const logs: LogEntry[] = [];

  function addLog(type: LogEntry['type'], step: string, message: string, data?: any) {
    const log = {
      timestamp: new Date().toISOString(),
      step,
      type,
      message,
      data,
    };
    logs.push(log);
    console.log(`[${type.toUpperCase()}] ${step}: ${message}`, data || '');
  }

  try {
    const email = `test-${Date.now()}@demo.local`;
    const password = 'SecurePass123!';
    const workspaceName = `Test Workspace ${new Date().toLocaleString()}`;

    addLog('info', 'start', `Creating tenant for: ${email}`);

    // Step 1: SignUp
    addLog('info', 'signup', 'Creating user...');
    try {
      await graphqlRequest(
        TWENTY_API_URL,
        `mutation SignUp($email: String!, $password: String!) {
          signUp(email: $email, password: $password) {
            tokens { refreshToken { token } }
          }
        }`,
        { email, password }
      );
      addLog('success', 'signup', 'User created');
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        addLog('info', 'signup', 'User already exists, continuing');
      } else {
        throw error;
      }
    }

    // Step 2: SignIn
    addLog('info', 'signin', 'Signing in...');
    const signInResult = await graphqlRequest(
      TWENTY_API_URL,
      `mutation SignIn($email: String!, $password: String!) {
        signIn(email: $email, password: $password) {
          tokens { accessOrWorkspaceAgnosticToken { token } }
        }
      }`,
      { email, password }
    );
    const userToken = signInResult.signIn.tokens.accessOrWorkspaceAgnosticToken.token;
    addLog('success', 'signin', `User token obtained (${userToken.slice(0, 30)}...)`);

    // Step 3: Create Workspace
    addLog('info', 'create-workspace', 'Creating workspace...');
    const wsResult = await graphqlRequest(
      TWENTY_API_URL,
      `mutation {
        signUpInNewWorkspace {
          loginToken { token }
          workspace {
            id
            workspaceUrls { subdomainUrl }
          }
        }
      }`,
      {},
      userToken
    );

    const workspaceId = wsResult.signUpInNewWorkspace.workspace.id;
    const loginToken = wsResult.signUpInNewWorkspace.loginToken.token;
    const workspaceUrl = wsResult.signUpInNewWorkspace.workspace.workspaceUrls.subdomainUrl;

    addLog('success', 'create-workspace', `Workspace created: ${workspaceId}`, {
      workspaceId,
      workspaceUrl,
    });

    // Step 4: Get Workspace Token
    addLog('info', 'workspace-token', 'Getting workspace token...');
    const tokensResult = await graphqlRequest(
      TWENTY_API_URL,
      `mutation GetTokens($loginToken: String!, $origin: String!) {
        getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
          tokens { accessOrWorkspaceAgnosticToken { token } }
        }
      }`,
      { loginToken, origin: workspaceUrl || TWENTY_FRONTEND_URL }
    );
    const workspaceToken = tokensResult.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
    addLog('success', 'workspace-token', `Workspace token obtained (${workspaceToken.slice(0, 30)}...)`);

    // Step 5: Activate
    addLog('info', 'activate', `Activating workspace: ${workspaceName}`);
    await graphqlRequest(
      TWENTY_API_URL,
      `mutation ActivateWorkspace($input: ActivateWorkspaceInput!) {
        activateWorkspace(data: $input) {
          id
          displayName
          activationStatus
        }
      }`,
      { input: { displayName: workspaceName } },
      workspaceToken
    );
    addLog('success', 'activate', 'Workspace activated');

    // Step 6: Wait for roles
    addLog('info', 'wait-roles', 'Waiting for roles (3 seconds)...');
    await sleep(3000);

    // Step 7: Get Roles
    addLog('info', 'get-roles', 'Fetching roles...');
    const rolesResult = await graphqlRequest(
      TWENTY_METADATA_URL,
      `query {
        getRoles {
          id
          label
        }
      }`,
      {},
      workspaceToken
    );

    if (!rolesResult.getRoles || rolesResult.getRoles.length === 0) {
      throw new Error('No roles found');
    }

    const roleId = rolesResult.getRoles[0].id;
    addLog('success', 'get-roles', `Role obtained: ${roleId} (${rolesResult.getRoles[0].label})`);

    // Step 8: Create API Key
    addLog('info', 'create-api-key', 'Creating API key...');
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const apiKeyResult = await graphqlRequest(
      TWENTY_METADATA_URL,
      `mutation CreateApiKey($input: CreateApiKeyDTO!) {
        createApiKey(input: $input) {
          id
          name
          expiresAt
        }
      }`,
      {
        input: {
          name: 'Test API Key',
          expiresAt,
          roleId,
        },
      },
      workspaceToken
    );

    const apiKeyId = apiKeyResult.createApiKey.id;
    addLog('success', 'create-api-key', `API key created: ${apiKeyId}`);

    // Step 9: Generate Token
    addLog('info', 'generate-token', 'Generating API key token...');
    const tokenResult = await graphqlRequest(
      TWENTY_API_URL,
      `mutation GenerateApiKeyToken($apiKeyId: UUID!, $expiresAt: String!) {
        generateApiKeyToken(apiKeyId: $apiKeyId, expiresAt: $expiresAt) {
          token
        }
      }`,
      { apiKeyId, expiresAt },
      workspaceToken
    );

    const apiKeyToken = tokenResult.generateApiKeyToken.token;
    addLog('success', 'generate-token', `API key token generated (${apiKeyToken.slice(0, 50)}...)`);

    // Generate auto-login URL
    const autoLoginUrl = `${workspaceUrl}verify?loginToken=${loginToken}`;
    addLog('success', 'complete', '✅ Tenant creation COMPLETE!', { autoLoginUrl });

    return NextResponse.json({
      success: true,
      workspace: {
        id: workspaceId,
        displayName: workspaceName,
        url: workspaceUrl,
      },
      credentials: {
        email,
        password,
      },
      apiKey: {
        id: apiKeyId,
        token: apiKeyToken,
        expiresAt,
      },
      autoLoginUrl,
      logs,
    });
  } catch (error: any) {
    addLog('error', 'failed', `❌ ERROR: ${error.message}`, { error: error.message });

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        logs,
      },
      { status: 500 }
    );
  }
}
