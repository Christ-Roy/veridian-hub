import { NextRequest, NextResponse } from 'next/server';
// Force dynamic rendering - prevent static generation at build time
export const dynamic = 'force-dynamic';
import { createClient } from '@/utils/supabase/server';

// Load Twenty URLs from environment variables
// Use empty default to allow build-time compilation, real value injected at runtime
const TWENTY_BASE_URL = process.env.NEXT_PUBLIC_TWENTY_URL || '';
const TWENTY_API_URL = TWENTY_BASE_URL ? `${TWENTY_BASE_URL}/graphql` : '';
const TWENTY_METADATA_URL = TWENTY_BASE_URL ? `${TWENTY_BASE_URL}/metadata` : '';
const TWENTY_FRONTEND_URL = TWENTY_BASE_URL;

interface LogEntry {
  timestamp: string;
  step: string;
  type: 'info' | 'success' | 'error' | 'warning';
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
    throw new Error(data.errors[0]?.message || 'GraphQL Error');
  }

  return data.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  const logs: LogEntry[] = [];

  // Runtime validation of required environment variables
  if (!TWENTY_BASE_URL) {
    return NextResponse.json(
      { error: 'Missing environment variable: NEXT_PUBLIC_TWENTY_URL' },
      { status: 500 }
    );
  }

  function addLog(type: LogEntry['type'], step: string, message: string, data?: any) {
    const log = {
      timestamp: new Date().toISOString(),
      step,
      type,
      message,
      data,
    };
    logs.push(log);

    // Log en dev mode
    if (process.env.NODE_ENV === 'development') {
      console.log(`[API Twenty] [${type.toUpperCase()}] ${step}: ${message}`, data || '');
    }
  }

  try {
    // 🔒 SÉCURITÉ : Vérifier que l'utilisateur est authentifié
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      addLog('error', 'auth', 'Unauthorized: User not authenticated');
      return NextResponse.json(
        { success: false, error: 'Unauthorized', logs },
        { status: 401 }
      );
    }

    addLog('info', 'auth', `User authenticated: ${user.email}`);

    const { email, password, workspaceName } = await request.json();

    if (!email || !password || !workspaceName) {
      addLog('error', 'validation', 'Missing required fields');
      return NextResponse.json(
        { success: false, error: 'Missing required fields', logs },
        { status: 400 }
      );
    }

    // 🔒 SÉCURITÉ : Vérifier que l'email correspond au user authentifié
    if (email !== user.email) {
      addLog('error', 'security', `Email mismatch: ${email} !== ${user.email}`);
      return NextResponse.json(
        { success: false, error: 'Email must match your account email', logs },
        { status: 403 }
      );
    }

    addLog('info', 'start', `Starting workspace creation for: ${email}`);

    // Step 1: SignUp
    addLog('info', 'signup', 'Creating user account...');

    const signUpMutation = `
      mutation SignUp($email: String!, $password: String!) {
        signUp(email: $email, password: $password) {
          tokens {
            refreshToken { token }
          }
        }
      }
    `;

    try {
      await graphqlRequest(TWENTY_API_URL, signUpMutation, { email, password });
      addLog('success', 'signup', 'User account created');
    } catch (error: any) {
      if (error.message?.includes('USER_ALREADY_EXISTS') || error.message?.includes('already exists')) {
        addLog('info', 'signup', 'User already exists, continuing...');
      } else {
        throw error;
      }
    }

    // Step 2: SignIn
    addLog('info', 'signin', 'Signing in to get user token...');

    const signInMutation = `
      mutation SignIn($email: String!, $password: String!) {
        signIn(email: $email, password: $password) {
          tokens {
            accessOrWorkspaceAgnosticToken { token }
          }
        }
      }
    `;

    const signInResult = await graphqlRequest(TWENTY_API_URL, signInMutation, { email, password });
    const userToken = signInResult.signIn.tokens.accessOrWorkspaceAgnosticToken.token;
    addLog('success', 'signin', 'User token obtained');

    // Step 3: Create Workspace
    addLog('info', 'create-workspace', 'Creating new workspace...');

    const createWsMutation = `
      mutation {
        signUpInNewWorkspace {
          loginToken { token }
          workspace {
            id
            workspaceUrls { subdomainUrl }
          }
        }
      }
    `;

    const wsResult = await graphqlRequest(TWENTY_API_URL, createWsMutation, {}, userToken);
    const workspaceId = wsResult.signUpInNewWorkspace.workspace.id;
    const loginToken = wsResult.signUpInNewWorkspace.loginToken.token;
    const workspaceUrl = wsResult.signUpInNewWorkspace.workspace.workspaceUrls.subdomainUrl;

    addLog('success', 'create-workspace', `Workspace created: ${workspaceId}`, {
      workspaceId,
      workspaceUrl,
    });

    // Step 4: Get Workspace Token
    addLog('info', 'workspace-token', 'Getting workspace access token...');

    const getTokensMutation = `
      mutation GetTokens($loginToken: String!, $origin: String!) {
        getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
          tokens {
            accessOrWorkspaceAgnosticToken { token }
          }
        }
      }
    `;

    const tokensResult = await graphqlRequest(TWENTY_API_URL, getTokensMutation, {
      loginToken,
      origin: workspaceUrl || TWENTY_FRONTEND_URL,
    });

    const workspaceToken = tokensResult.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
    addLog('success', 'workspace-token', 'Workspace token obtained');

    // Step 5: Activate Workspace
    addLog('info', 'activate', `Activating workspace with name: ${workspaceName}`);

    const activateMutation = `
      mutation ActivateWorkspace($input: ActivateWorkspaceInput!) {
        activateWorkspace(data: $input) {
          id
          displayName
          activationStatus
        }
      }
    `;

    await graphqlRequest(
      TWENTY_API_URL,
      activateMutation,
      { input: { displayName: workspaceName } },
      workspaceToken
    );

    addLog('success', 'activate', 'Workspace activated');

    // Step 6: Wait for roles
    addLog('info', 'wait-roles', 'Waiting for roles to be created (3 seconds)...');
    await sleep(3000);

    // Step 7: Get Roles
    addLog('info', 'get-roles', 'Fetching default role...');

    const getRolesQuery = `
      query {
        getRoles {
          id
          label
        }
      }
    `;

    const rolesResult = await graphqlRequest(TWENTY_METADATA_URL, getRolesQuery, {}, workspaceToken);

    if (!rolesResult.getRoles || rolesResult.getRoles.length === 0) {
      throw new Error('No roles found in workspace');
    }

    const roleId = rolesResult.getRoles[0].id;
    addLog('success', 'get-roles', `Role obtained: ${roleId}`);

    // Step 8: Create API Key
    addLog('info', 'create-api-key', 'Creating API key...');

    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const createApiKeyMutation = `
      mutation CreateApiKey($input: CreateApiKeyDTO!) {
        createApiKey(input: $input) {
          id
          name
          expiresAt
        }
      }
    `;

    const apiKeyResult = await graphqlRequest(
      TWENTY_METADATA_URL,
      createApiKeyMutation,
      {
        input: {
          name: 'Dashboard Auto-generated Key',
          expiresAt,
          roleId,
        },
      },
      workspaceToken
    );

    const apiKeyId = apiKeyResult.createApiKey.id;
    addLog('success', 'create-api-key', `API key created: ${apiKeyId}`);

    // Step 9: Generate API Key Token
    addLog('info', 'generate-token', 'Generating API key token...');

    const generateTokenMutation = `
      mutation GenerateApiKeyToken($apiKeyId: UUID!, $expiresAt: String!) {
        generateApiKeyToken(apiKeyId: $apiKeyId, expiresAt: $expiresAt) {
          token
        }
      }
    `;

    const tokenResult = await graphqlRequest(
      TWENTY_API_URL,
      generateTokenMutation,
      { apiKeyId, expiresAt },
      workspaceToken
    );

    const apiKeyToken = tokenResult.generateApiKeyToken.token;
    addLog('success', 'generate-token', 'API key token generated');

    // Generate auto-login URL
    const autoLoginUrl = `${workspaceUrl}verify?loginToken=${loginToken}`;
    addLog('success', 'complete', 'Tenant creation completed!', { autoLoginUrl });

    // Save to Supabase (réutilise supabase et user déjà déclarés)
    if (user) {
      const { error: dbError } = await supabase.from('tenants').upsert({
        user_id: user.id,
        name: workspaceName,
        slug: `twenty-${workspaceId.slice(0, 8)}`,
        status: 'active',
        twenty_workspace_id: workspaceId,
        twenty_user_email: email,
        twenty_user_password: password,
        twenty_api_key: apiKeyToken,
      } as any);

      if (dbError) {
        addLog('error', 'database', `Failed to save to database: ${dbError.message}`);
      } else {
        addLog('success', 'database', 'Tenant saved to database');
      }
    }

    return NextResponse.json({
      success: true,
      workspace: {
        id: workspaceId,
        displayName: workspaceName,
        subdomain: new URL(workspaceUrl).hostname.split('.')[0],
        activationStatus: 'active',
      },
      tokens: {
        accessToken: workspaceToken,
        refreshToken: null,
      },
      apiKey: {
        token: apiKeyToken,
        expiresAt,
      },
      credentials: {
        email,
        password,
      },
      autoLoginUrl,
      logs,
    });
  } catch (error: any) {
    addLog('error', 'failed', `Error: ${error.message}`, { error: error.message });

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Unknown error',
        logs,
      },
      { status: 500 }
    );
  }
}
