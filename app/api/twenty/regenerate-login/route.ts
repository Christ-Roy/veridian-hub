import { NextRequest, NextResponse } from 'next/server';
// Force dynamic rendering - prevent static generation at build time
export const dynamic = 'force-dynamic';

// Load Twenty URLs from environment variables
// Use empty default to allow build-time compilation, real value injected at runtime
const TWENTY_BASE_URL = process.env.NEXT_PUBLIC_TWENTY_URL || '';
const TWENTY_API_URL = TWENTY_BASE_URL ? `${TWENTY_BASE_URL}/graphql` : '';
const TWENTY_FRONTEND_URL = TWENTY_BASE_URL;

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

export async function POST(request: NextRequest) {
  try {
    // Runtime validation of required environment variables
    if (!TWENTY_BASE_URL) {
      return NextResponse.json(
        { success: false, error: 'Missing environment variable: NEXT_PUBLIC_TWENTY_URL' },
        { status: 500 }
      );
    }

    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Missing email or password' },
        { status: 400 }
      );
    }

    // Step 1: SignIn to get user token
    const signInMutation = `
      mutation SignIn($email: String!, $password: String!) {
        signIn(email: $email, password: $password) {
          tokens {
            accessOrWorkspaceAgnosticToken { token }
          }
          user {
            workspaces {
              workspace {
                id
                workspaceUrls { subdomainUrl }
              }
            }
          }
        }
      }
    `;

    const signInResult = await graphqlRequest(TWENTY_API_URL, signInMutation, { email, password });

    const userToken = signInResult.signIn.tokens.accessOrWorkspaceAgnosticToken.token;
    const workspaces = signInResult.signIn.user.workspaces;

    if (!workspaces || workspaces.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No workspace found for this user' },
        { status: 404 }
      );
    }

    // Use the first workspace (default)
    const workspace = workspaces[0].workspace;
    const workspaceUrl = workspace.workspaceUrls.subdomainUrl;

    // Step 2: Generate a fresh loginToken
    // The userToken itself can be used for auto-login
    const autoLoginUrl = `${workspaceUrl}verify?loginToken=${userToken}`;

    return NextResponse.json({
      success: true,
      autoLoginUrl,
      workspace: {
        id: workspace.id,
        url: workspaceUrl,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to regenerate login token',
      },
      { status: 500 }
    );
  }
}
